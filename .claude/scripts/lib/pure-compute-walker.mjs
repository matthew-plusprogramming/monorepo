/**
 * DFS Walker for Pure-Compute Static Check
 *
 * Walks the transitive import graph from spec-declared entry points, using a
 * two-state visited set (`in-progress` / `finalized`) for cycle detection.
 * Cycle nodes are folded into a single equivalence class: if ANY node in the
 * class imports a blocklisted symbol, ALL nodes in the class appear in the
 * violation list.
 *
 * Orchestrates:
 *   - `pure-compute-resolver.mjs` (as-002) for specifier -> absolute path
 *   - `pure-compute-extractor.mjs` (as-003) for static/dynamic imports + re-exports
 *   - `pure-compute-scanner.mjs` (as-004) for callsite-level matches
 *   - `pure-compute-matcher.mjs` (as-005) for blocklist lookup + safelist
 *
 * Canonical-shape aggregation (AC6.15, contract boundary enforcement):
 *   The matcher emits intermediate records with a `category` field for
 *   diagnostics. The walker STRIPS `category` before returning the final
 *   `Violation[]`. The public-API `Violation` shape is exactly 4 fields:
 *   `{file, importSpecifier, symbol, pathToEntry}`.
 *
 * Fail-closed (AC6.12, AC6.13, AC6.14):
 *   - resolver returns null   -> violation with symbol='<resolution-failed>'
 *   - extractor reports parse error -> violation with symbol='<parse-error>'
 *   - walker continues exploring remaining frontier nodes
 *   - verdict='fail' iff violations.length > 0
 *   - Silent warn-and-continue is EXPLICITLY REJECTED
 *
 * Determinism (AC6.11):
 *   - Frontier is processed in DFS order
 *   - Sibling resolution is alphabetically sorted
 *   - Type-only imports are filtered from frontier population (AC6.10)
 *
 * Spec: sg-e2e-pure-compute-check atomic as-006 (Tasks T6 + T15)
 * Requirements: REQ-F-011
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute, dirname, sep as pathSep } from 'node:path';

import { loadTsconfig, resolveSpecifier } from './pure-compute-resolver.mjs';
import { extractFromSource, parseSourceToAst } from './pure-compute-extractor.mjs';
import { scanCallSites } from './pure-compute-scanner.mjs';
import {
  matchBlocklist,
  isSafeList,
  makeResolutionFailedViolation,
  makeParseErrorViolation,
} from './pure-compute-matcher.mjs';
import { assertContainment, PathEscapeError } from './path-containment.mjs';

// =============================================================================
// Public API
// =============================================================================

/**
 * @typedef {Object} Violation
 * @property {string} file
 * @property {string} importSpecifier
 * @property {string} symbol
 * @property {string[]} pathToEntry
 *
 * @typedef {Object} WalkResult
 * @property {Map<string, 'in-progress'|'finalized'>} visited
 * @property {Violation[]} violations
 * @property {Array<Set<string>>} cycles
 */

/**
 * Walk the transitive import graph.
 *
 * @param {Object} params
 * @param {string[]} params.entryPoints - Absolute-or-relative file paths
 * @param {string} [params.tsconfigPath] - Optional tsconfig.json path
 * @returns {Promise<WalkResult>}
 */
export async function walkGraph(params) {
  const { entryPoints, tsconfigPath } = params || {};

  // Load tsconfig (AC2.4, AC2.5, AC2.7, AC2.8). Malformed / missing tsconfig
  // yields an empty alias map; relative/absolute resolution still works.
  const tsconfig = loadTsconfig(tsconfigPath, {
    warn: () => {
      // Graceful-degradation policy: single loader diagnostic via no-op here.
      // The contract does not surface loader warnings through checkPureCompute's
      // return value. Callers who need them can invoke loadTsconfig directly.
    },
  });

  const visited = new Map(); // absPath -> 'in-progress' | 'finalized'
  const violations = []; // intermediate; stripped to canonical 4-field shape at the end
  const cycles = []; // Set<absPath>[] for each detected equivalence class

  // Normalize entry points to absolute paths.
  const absEntryPoints = entryPoints.map((p) => (isAbsolute(p) ? p : resolve(process.cwd(), p)));

  // SEC-TRAVERSAL-001: derive containment root and attach to the tsconfig model.
  // Rule (documented in spec.md L314):
  //   1. tsconfig.baseUrl when tsconfig loaded (explicit project boundary)
  //   2. else longest common ancestor of entry-point dirs (derived boundary)
  //   3. else dirname of the first entry point (single-entry fallback)
  // The resolver reads cfg.projectRoot and gates every candidate through
  // assertContainment. Escapes return null -> <resolution-failed> fail-closed.
  //
  // The derived root is canonicalized via realpath so the containment check
  // (which realpaths candidates) compares like-against-like. Without this,
  // symlink-backed filesystem roots (/tmp -> /private/tmp on macOS,
  // /var -> /private/var) cause every candidate to appear out-of-root.
  const rawProjectRoot = deriveProjectRoot(tsconfig, absEntryPoints);
  const projectRoot = canonicalizeRoot(rawProjectRoot);
  tsconfig.projectRoot = projectRoot;

  // Traverse each entry point with its own pathToEntry stack.
  for (const entry of absEntryPoints) {
    // SEC-TRAVERSAL-001: entry-point containment gate. Only enforced when the
    // containment root came from tsconfig (independent boundary); when the
    // root was derived FROM the entry points, the first entry trivially passes
    // its own containment check, so the gate adds no safety in that case.
    // Enforcing it only for tsconfig-declared roots catches the case where a
    // malicious spec author declares both a tsconfig AND an out-of-tree entry
    // point. We test against `tsconfig.baseUrl` (the pre-canonicalized source)
    // rather than the derived `projectRoot` because the latter may have been
    // realpath'd and no longer string-compares.
    const containedEntry = tsconfig.baseUrl ? safeContain(entry, projectRoot) : entry;

    if (!containedEntry) {
      // Entry point escapes the tsconfig-declared root -> emit <resolution-failed>
      // and skip. Uses `entry` (the unresolved input) as both `file` and
      // `importSpecifier` so the diagnostic identifies the escape origin
      // without leaking the canonicalized realpath.
      violations.push({
        ...makeResolutionFailedViolation({ file: entry, importSpecifier: entry }),
        pathToEntry: [entry],
      });
      continue;
    }

    dfs({
      file: containedEntry,
      pathStack: [containedEntry],
      tsconfig,
      visited,
      violations,
      cycles,
      entryPoint: containedEntry,
    });
  }

  // Equivalence-class propagation (AC6.5): fold cycle classes so that any
  // violation owned by one cycle member propagates to every other member.
  // `cycles` may contain overlapping sets; merge them first via union-find.
  const mergedClasses = mergeEquivalenceClasses(cycles);
  const propagated = propagateCycleViolations(violations, mergedClasses, visited);

  // Canonical-shape aggregation (AC6.15): strip `category`, emit 4 fields only.
  const canonicalViolations = propagated.map((v) => ({
    file: v.file,
    importSpecifier: v.importSpecifier,
    symbol: v.symbol,
    pathToEntry: [...v.pathToEntry],
  }));

  return {
    visited,
    violations: canonicalViolations,
    cycles,
  };
}

// =============================================================================
// Internal: DFS body
// =============================================================================

/**
 * Recursive DFS. Mutates `visited`, `violations`, `cycles`.
 *
 * @param {Object} ctx
 * @param {string} ctx.file - Absolute path of current node
 * @param {string[]} ctx.pathStack - Path from entry to current node (inclusive)
 * @param {{paths: Object, baseUrl: string|null, path: string|null}} ctx.tsconfig
 * @param {Map<string, string>} ctx.visited
 * @param {Array} ctx.violations - Accumulator (intermediate shape with category)
 * @param {Array<Set<string>>} ctx.cycles
 * @param {string} ctx.entryPoint - The entry point that originated this walk
 */
function dfs(ctx) {
  const { file, pathStack, tsconfig, visited, violations, cycles, entryPoint } = ctx;

  const state = visited.get(file);
  if (state === 'finalized') {
    return; // Already fully explored in another branch.
  }
  if (state === 'in-progress') {
    // Cycle detected: fold every node on the current pathStack from the first
    // occurrence of `file` to the most recent entry into an equivalence class
    // (AC6.3, AC6.4, AC6.5).
    //
    // The pathStack at cycle time contains: [...ancestors, file, ...descendants, file]
    // The class is the sub-slice from the first `file` to the end (including
    // all descendants that looped back).
    const classMembers = new Set();
    const firstIdx = pathStack.indexOf(file);
    if (firstIdx === -1) {
      classMembers.add(file);
    } else {
      for (let i = firstIdx; i < pathStack.length; i++) {
        classMembers.add(pathStack[i]);
      }
    }
    classMembers.add(file); // Re-enter node always in class.
    cycles.push(classMembers);
    return;
  }

  visited.set(file, 'in-progress');

  // Read + extract.
  let source;
  try {
    source = readFileSync(file, 'utf-8');
  } catch (err) {
    // Read failure = treated as parse-error (fail-closed AC6.13).
    violations.push({
      ...makeParseErrorViolation({ file }),
      pathToEntry: [...pathStack],
    });
    visited.set(file, 'finalized');
    return;
  }

  const extracted = extractFromSource(source, file);
  if (extracted.parseError) {
    // AC6.13 fail-closed parse-error emission.
    violations.push({
      ...makeParseErrorViolation({ file }),
      pathToEntry: [...pathStack],
    });
    // Continue to scan imports anyway -- partial AST may still yield edges.
  }

  // Callsite scanner uses the AST we already parsed.
  const sourceFile = parseSourceToAst(source, file);
  const callSites = scanCallSites(sourceFile, extracted.imports);

  // Module-level matches (one per unique non-type-only import / re-export specifier).
  const moduleSpecifiers = collectModuleSpecifiers(extracted);

  for (const specifier of moduleSpecifiers) {
    // Safelist short-circuit (AC5.3).
    if (isSafeList(specifier)) continue;

    // Match module-level blocklist.
    const matches = matchBlocklist({
      specifier,
      callSites: [],
      dynamicImports: [],
      file,
    });
    for (const m of matches) {
      violations.push({ ...m, pathToEntry: [...pathStack] });
    }
  }

  // Callsite violations (separate pass so the file context is attached to each).
  const callMatches = matchBlocklist({
    specifier: undefined,
    callSites,
    dynamicImports: extracted.dynamicImports,
    file,
  });
  for (const m of callMatches) {
    violations.push({ ...m, pathToEntry: [...pathStack] });
  }

  // Resolve + recurse through outgoing edges (non-type-only imports + re-exports).
  const outgoingEdges = collectOutgoingEdges(extracted);
  // Sort alphabetically for deterministic traversal order (AC6.11).
  outgoingEdges.sort((a, b) => a.specifier.localeCompare(b.specifier));

  for (const edge of outgoingEdges) {
    const spec = edge.specifier;

    // Try resolver first so tsconfig aliases (both `@app/*` and bare-aliased
    // patterns like `foo/*`) get a chance to resolve to a file.
    const resolved = resolveSpecifier(spec, file, tsconfig);

    if (!resolved) {
      // Relative / absolute paths that don't resolve are always fail-closed
      // resolution-failed (AC6.12): typos must not silently bypass the check.
      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
        violations.push({
          ...makeResolutionFailedViolation({ file, importSpecifier: spec }),
          pathToEntry: [...pathStack],
        });
        continue;
      }

      // Bare specifiers / node builtins / unresolvable node_modules packages:
      // the module-level blocklist/safelist matcher has already handled them.
      // If the specifier matches neither (e.g. `lodash`), it is allowed -- the
      // blocklist is exhaustive for dangerous modules per contract.
      // Tsconfig-alias candidates (`@`, `~`, `#`) that fail resolution emit
      // <resolution-failed> since authors declared them as project-relative.
      if (spec.startsWith('@') || spec.startsWith('~') || spec.startsWith('#')) {
        violations.push({
          ...makeResolutionFailedViolation({ file, importSpecifier: spec }),
          pathToEntry: [...pathStack],
        });
      }
      continue;
    }

    dfs({
      file: resolved,
      pathStack: [...pathStack, resolved],
      tsconfig,
      visited,
      violations,
      cycles,
      entryPoint,
    });
  }

  visited.set(file, 'finalized');
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Collect unique module specifiers from imports + re-exports, filtering
 * type-only imports.
 */
function collectModuleSpecifiers(extracted) {
  const set = new Set();
  for (const imp of extracted.imports || []) {
    if (imp.isTypeOnly) continue;
    // Mixed import: if the whole decl isn't type-only but every binding is,
    // treat as type-only.
    if (
      imp.nameBindings && imp.nameBindings.length > 0 &&
      imp.nameBindings.every((b) => b.isTypeOnly)
    ) {
      continue;
    }
    set.add(imp.specifier);
  }
  for (const re of extracted.reexports || []) {
    set.add(re.specifier);
  }
  return Array.from(set).sort();
}

/**
 * Collect outgoing edges (non-type-only imports + re-exports) with de-duplication.
 */
function collectOutgoingEdges(extracted) {
  const edges = [];
  const seen = new Set();
  for (const imp of extracted.imports || []) {
    if (imp.isTypeOnly) continue;
    if (
      imp.nameBindings && imp.nameBindings.length > 0 &&
      imp.nameBindings.every((b) => b.isTypeOnly)
    ) {
      continue;
    }
    if (!seen.has(imp.specifier)) {
      seen.add(imp.specifier);
      edges.push({ specifier: imp.specifier, kind: 'import' });
    }
  }
  for (const re of extracted.reexports || []) {
    if (!seen.has(re.specifier)) {
      seen.add(re.specifier);
      edges.push({ specifier: re.specifier, kind: 'reexport' });
    }
  }
  return edges;
}

/**
 * Merge overlapping cycle sets into disjoint equivalence classes via a simple
 * union-find pass. Two sets are merged if they share at least one member.
 *
 * @param {Array<Set<string>>} cycles
 * @returns {Array<Set<string>>}
 */
function mergeEquivalenceClasses(cycles) {
  if (cycles.length === 0) return [];
  // Iterative merge: fix-point until no changes.
  const classes = cycles.map((c) => new Set(c));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < classes.length; i++) {
      for (let j = i + 1; j < classes.length; j++) {
        const a = classes[i];
        const b = classes[j];
        // Check intersection.
        let overlap = false;
        for (const member of b) {
          if (a.has(member)) { overlap = true; break; }
        }
        if (overlap) {
          for (const member of b) a.add(member);
          classes.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return classes;
}

/**
 * Derive the containment root for resolver candidates (SEC-TRAVERSAL-001).
 *
 * Precedence (highest to lowest):
 *   1. `tsconfig.baseUrl` when tsconfig was loaded (explicit tsconfig boundary)
 *   2. Longest common ancestor directory of all entry points
 *   3. `dirname(firstEntry)` as single-entry fallback
 *   4. null when no entry points (caller will degenerate; resolver skips check)
 *
 * @param {{baseUrl: string|null}} tsconfig
 * @param {string[]} absEntryPoints - Absolute entry paths (may or may not exist yet)
 * @returns {string|null}
 */
function deriveProjectRoot(tsconfig, absEntryPoints) {
  if (tsconfig && tsconfig.baseUrl) return tsconfig.baseUrl;
  if (!Array.isArray(absEntryPoints) || absEntryPoints.length === 0) return null;
  if (absEntryPoints.length === 1) return dirname(absEntryPoints[0]);
  return longestCommonAncestor(absEntryPoints.map((p) => dirname(p)));
}

/**
 * Canonicalize a root path so containment comparisons line up with the
 * candidate realpaths. `realpathSync` on a missing directory throws ENOENT; in
 * that degenerate case return the raw root so callers still get a best-effort
 * gate (candidate realpath will also fail, yielding null -> fail-closed).
 *
 * @param {string|null} root
 * @returns {string|null}
 */
function canonicalizeRoot(root) {
  if (!root) return null;
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * Longest common directory prefix over a list of absolute directory paths.
 * Splits on `path.sep` and keeps the common head. Returns the first path
 * unchanged when the list has one entry; returns `pathSep` (root) only if
 * inputs diverge at the very first segment (which should not happen for
 * properly-rooted inputs on a single filesystem).
 *
 * @param {string[]} dirs
 * @returns {string}
 */
function longestCommonAncestor(dirs) {
  if (dirs.length === 0) return '';
  if (dirs.length === 1) return dirs[0];
  const split = dirs.map((d) => d.split(pathSep));
  const minLen = Math.min(...split.map((s) => s.length));
  const common = [];
  for (let i = 0; i < minLen; i++) {
    const seg = split[0][i];
    if (split.every((s) => s[i] === seg)) common.push(seg);
    else break;
  }
  return common.join(pathSep) || pathSep;
}

/**
 * Realpath + containment check that swallows `PathEscapeError` and returns null.
 * Mirrors `containOrNull` in the resolver; kept as a local helper for the
 * walker's entry-point gate so we don't reach across module boundaries.
 *
 * @param {string} candidate
 * @param {string|null} projectRoot
 * @returns {string|null}
 */
function safeContain(candidate, projectRoot) {
  if (!projectRoot) return candidate;
  try {
    return assertContainment(candidate, projectRoot);
  } catch (err) {
    if (err instanceof PathEscapeError) return null;
    return null; // ENOENT / EACCES -> treat as unresolvable, fail-closed.
  }
}

/**
 * For each equivalence class that contains at least one blocklist violation,
 * emit a duplicate violation for every other class member so the caller sees
 * all cycle nodes in the final list.
 *
 * The duplicated violation preserves `symbol` and `importSpecifier` from the
 * source violation but attributes `file` to the cycle member and preserves
 * the original `pathToEntry`. This satisfies AC6.5 ("both A and B must appear
 * among violation `file` paths") and AC6.15 (canonical-shape aggregation via
 * the caller's strip step).
 *
 * Excludes: <resolution-failed> and <parse-error> (these are file-specific;
 * propagating them across a cycle would mislead authors into thinking the
 * parse error is in B when it's actually in A).
 *
 * @param {Array} violations
 * @param {Array<Set<string>>} mergedClasses
 * @param {Map<string, string>} visited - All files the walker touched
 * @returns {Array}
 */
function propagateCycleViolations(violations, mergedClasses, visited) {
  if (mergedClasses.length === 0) return violations;

  const propagated = [...violations];
  const NON_PROPAGATING_SYMBOLS = new Set(['<resolution-failed>', '<parse-error>']);

  for (const cls of mergedClasses) {
    // Collect violations whose `file` is in this class.
    const classViolations = violations.filter((v) => cls.has(v.file));
    for (const v of classViolations) {
      if (NON_PROPAGATING_SYMBOLS.has(v.symbol)) continue;
      // Emit a duplicate for every OTHER class member.
      for (const member of cls) {
        if (member === v.file) continue;
        // Don't re-emit if another violation with this (file, symbol) pair exists.
        const already = propagated.some(
          (p) => p.file === member && p.symbol === v.symbol && p.importSpecifier === v.importSpecifier,
        );
        if (already) continue;
        propagated.push({
          ...v,
          file: member,
          // Use the class member's own pathToEntry (approximate via the original
          // chain: replace the final element with `member`).
          pathToEntry: [...v.pathToEntry.slice(0, -1), member],
        });
      }
    }
  }

  return propagated;
}
