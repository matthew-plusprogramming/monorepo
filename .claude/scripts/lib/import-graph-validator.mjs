/**
 * Import-graph validator for the metaclaude registry sync.
 *
 * Parses every registered `.mjs` artifact via `acorn` and walks the AST for
 * ImportDeclaration, ExportNamedDeclaration{source}, ExportAllDeclaration, and
 * `import(...)` call expressions. For each RELATIVE specifier (leading `./` or
 * `../`), the validator resolves to a canonical path via realpath + containment
 * (see lib/path-containment.mjs), then classifies the target as one of:
 *
 *   - orphan / not-registered -> rule "import-unregistered"
 *   - outside .claude/        -> rule "path-escape"
 *   - missing on disk         -> rule "import-target-missing"
 *   - parse-errored file      -> rule "import-target-unresolvable"
 *   - whitelisted test file   -> rule "test-leaf-violation"
 *   - registered but wrong bundle -> rule "cross-bundle-closure"
 *
 * Parse errors are collected and emit `parse-error` findings; the importer
 * continues processing remaining files (AC-29.1, AC-29.2).
 *
 * Performance (REQ-021a / AC-21a.1):
 *   - Serial parse only. NO worker pool. NO AST cache. NO persistence across runs.
 *   - Budget: <= 5 s wall-clock on the metaclaude repo.
 *   - Observability: wall-clock duration emitted in the return value; caller may
 *     print to stderr at --verbose level.
 *   - See spec §5.4. Future activation trigger for a worker pool: wall-clock > 5 s.
 *     Future activation trigger for an mtime-keyed cache: artifact count > 500
 *     OR wall-clock > 5 s. Both activation triggers require a source-level code
 *     change in this file. The cache deliberately does NOT exist yet; adding it
 *     requires explicit authorization because stale caches are a known source of
 *     correctness bugs.
 *
 * Spec: sg-sync-registry-gaps T2.2, T3.1, REQ-009, REQ-010, REQ-016, REQ-017,
 * REQ-021a, REQ-029.
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, sep as pathSep } from 'node:path';
import * as acorn from 'acorn';

import { assertContainment, PathEscapeError } from './path-containment.mjs';
import { BUNDLE_INHERITANCE, WHITELIST_GLOBS, matchesAnyGlob } from './sync-constants.mjs';
import { iterateArtifactEntries } from './registry-schema.mjs';

// Resolver precedence for relative specifiers (AC-9.3).
const RESOLVER_EXTENSIONS = ['.mjs', '.js', '.json'];

/**
 * Error raised when an import target cannot be resolved for a reason that is
 * neither PathEscapeError nor ENOENT -- e.g., EACCES on realpath, ELOOP on
 * symlink cycles, or any other fs error bubbling from `assertContainment`.
 *
 * Carries a machine-readable `error_code` so callers can distinguish this
 * from other structured violations at the rule level.
 *
 * The inner `cause` is passed via `super({ cause })` (Node 16.9+ Error options)
 * so `.cause` is wired into the prototype chain instead of being a plain
 * instance property. This gives standard Error serializers (util.inspect,
 * Error.prototype.toString) correct traversal through the cause chain.
 *
 * Spec: sg-sync-registry-gaps cr-error-handling-1b8fe042, cr-error-handling-9c3e7a15.
 */
export class ImportResolutionUnknownError extends Error {
  constructor({ specifier, importerPath, cause }) {
    super(
      `Unknown import resolution failure for ${specifier} in ${importerPath}: ${cause?.message || String(cause)}`,
      // Node 16.9+ Error options: wires `cause` through the Error prototype
      // chain so downstream code and serializers see it via `.cause`.
      // Spec: sg-sync-registry-gaps cr-error-handling-9c3e7a15.
      { cause }
    );
    this.name = 'ImportResolutionUnknownError';
    this.error_code = 'import_resolution_unknown';
    this.blame = 'self';
    this.retry_safe = false;
    this.specifier = specifier;
    this.importerPath = importerPath;
  }
}

/**
 * Build a map from repo-relative path -> bundle name by walking the registry
 * bundles[].includes[] arrays. The last bundle to claim a path wins (though a
 * well-formed registry never has duplicates). Artifacts with no bundle membership
 * are absent from the map.
 *
 * @param {object} registry - Parsed registry
 * @returns {Map<string, string>} path -> bundle name
 */
function buildPathToBundle(registry) {
  const idToPath = new Map();
  for (const { category, id, entry } of iterateArtifactEntries(registry)) {
    if (typeof entry.path !== 'string') continue;
    // Register both the canonical `category/id` form AND the raw `id` form to
    // tolerate test helpers that key artifacts with the full reference string
    // (e.g., `artifacts.scripts['scripts/foo']`) as well as the conventional
    // `artifacts.scripts.foo` shape.
    idToPath.set(`${category}/${id}`, entry.path);
    if (id.includes('/')) {
      idToPath.set(id, entry.path);
    }
  }
  const pathToBundle = new Map();
  for (const [bundleName, bundle] of Object.entries(registry.bundles || {})) {
    for (const ref of bundle.includes || []) {
      const path = idToPath.get(ref);
      if (path) pathToBundle.set(path, bundleName);
    }
  }
  return pathToBundle;
}

/**
 * Try resolving a relative specifier against the importer's directory, using
 * the configured extension precedence.
 *
 * Precedence matches node's own `.mjs` extension resolution: if the specifier
 * has an explicit extension, use it verbatim; otherwise try `.mjs`, `.js`,
 * `.json` in order.
 *
 * @param {string} specifier - Relative specifier ('./foo.mjs' or './foo')
 * @param {string} importerAbsPath - Absolute path to the file doing the import
 * @returns {string | null} Absolute target path if resolvable, else null
 */
function resolveRelativeSpecifier(specifier, importerAbsPath) {
  const importerDir = dirname(importerAbsPath);

  // Case 1: specifier already has an extension we understand.
  const explicitExt = RESOLVER_EXTENSIONS.find((ext) => specifier.endsWith(ext));
  if (explicitExt) {
    const abs = resolve(importerDir, specifier);
    return existsSync(abs) ? abs : null;
  }

  // Case 2: try each candidate extension in order.
  for (const ext of RESOLVER_EXTENSIONS) {
    const abs = resolve(importerDir, specifier + ext);
    if (existsSync(abs)) return abs;
  }

  // Case 3: bare extension-less path pointing at a directory with an index file.
  for (const ext of RESOLVER_EXTENSIONS) {
    const abs = join(resolve(importerDir, specifier), 'index' + ext);
    if (existsSync(abs)) return abs;
  }

  return null;
}

/**
 * Extract every relative specifier referenced by the AST.
 *
 * Walks the top-level body for ImportDeclaration, ExportAllDeclaration,
 * ExportNamedDeclaration{source}, and recursively scans CallExpressions of shape
 * `import(literal)`. Nested import() calls are also found because we do a shallow
 * walk of nested nodes.
 *
 * Bare specifiers (no leading `./`) are silently skipped -- they are handled by
 * node's node_modules resolution and are out of scope for the registry sync.
 * Dynamic `import(variable)` / `import(\`...${}\`)` is logged as a warning and
 * skipped (AC-9.5).
 *
 * @param {object} ast - Acorn-parsed Program node
 * @returns {{specifiers: string[], dynamicWarnings: number}} relative specifiers and dynamic-import warning count
 */
function extractRelativeSpecifiers(ast) {
  const specifiers = [];
  let dynamicWarnings = 0;

  // Helper to record a literal specifier if it's relative.
  const addIfRelative = (value) => {
    if (typeof value !== 'string') return;
    if (value.startsWith('./') || value.startsWith('../')) {
      specifiers.push(value);
    }
  };

  // Walk all AST nodes -- we don't need a full visitor, just recurse shallowly.
  const queue = [ast];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;

    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        if (node.source && typeof node.source.value === 'string') {
          addIfRelative(node.source.value);
        }
        break;
      case 'ExportNamedDeclaration':
        if (node.source && typeof node.source.value === 'string') {
          addIfRelative(node.source.value);
        }
        break;
      case 'ImportExpression':
        // ESTree: dynamic `import(...)` becomes ImportExpression with `source` node.
        if (node.source && node.source.type === 'Literal' && typeof node.source.value === 'string') {
          addIfRelative(node.source.value);
        } else {
          dynamicWarnings += 1;
        }
        break;
      case 'CallExpression':
        // Acorn may emit CallExpression{callee: Import} for older tree shapes.
        if (node.callee && node.callee.type === 'Import') {
          if (node.arguments && node.arguments.length === 1) {
            const arg = node.arguments[0];
            if (arg.type === 'Literal' && typeof arg.value === 'string') {
              addIfRelative(arg.value);
            } else {
              dynamicWarnings += 1;
            }
          }
        }
        break;
      default:
        break;
    }

    // Recurse into children.
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c === 'object') queue.push(c);
        }
      } else if (child && typeof child === 'object') {
        queue.push(child);
      }
    }
  }

  return { specifiers, dynamicWarnings };
}

/**
 * Check whether importee's bundle is reachable from importer's bundle.
 *
 * Rule (AC-10.1 / AC-10.2 / AC-10.3 / AC-10.4):
 *   1. If the bundles are equal, allow (same-bundle base case).
 *   2. Otherwise look up importer's ancestor list from BUNDLE_INHERITANCE and
 *      allow if importee is in the ancestor list.
 *   3. Otherwise reject with cross-bundle-closure.
 *
 * The constant is used directly; the registry's `bundles[].extends` field is
 * NOT consulted (code-constants-over-registry-metadata convention).
 *
 * @param {string} importerBundle - Bundle name of the importer (may be undefined)
 * @param {string} importeeBundle - Bundle name of the importee (may be undefined)
 * @returns {boolean} true if the edge is allowed
 */
function closureAllowed(importerBundle, importeeBundle) {
  if (!importerBundle || !importeeBundle) return true; // unknown bundles are not our concern here
  if (importerBundle === importeeBundle) return true;
  const ancestors = BUNDLE_INHERITANCE[importerBundle];
  if (!Array.isArray(ancestors)) return true; // unknown importer bundle -> don't block
  return ancestors.includes(importeeBundle);
}

/**
 * Validate the import graph of every registered `.mjs` artifact.
 *
 * @param {object} registry - Parsed registry
 * @param {string} repoRoot - Absolute path to the repo root
 * @param {object} [options]
 * @param {string} [options.claudeRoot] - Override for the claude root (default: repoRoot/.claude)
 * @returns {{findings: Array<object>, duration_ms: number, parse_error_count: number, dynamic_warning_count: number, scanned: number}}
 */
export function validateImports(registry, repoRoot, options = {}) {
  // Canonicalize repoRoot once. Without this, registeredAbsPaths contains
  // non-canonical entries (symlink-prefixed, `..`-containing) while the
  // import-resolution path goes through realpath and produces the canonical
  // form, so set-membership checks silently miss. Applying realpath here
  // guarantees both sides of the comparison use the same canonical shape.
  // Spec: sg-sync-registry-gaps cr-other-9e5b301f.
  let canonicalRepoRoot;
  try {
    canonicalRepoRoot = realpathSync(repoRoot);
  } catch {
    // If realpath fails (ENOENT on the repo root), fall back to the raw value.
    // Downstream lookups may still miss, but callers will surface the ENOENT.
    canonicalRepoRoot = repoRoot;
  }
  const claudeRoot = options.claudeRoot || join(canonicalRepoRoot, '.claude');
  const start = performance.now();

  const findings = [];
  const pathToBundle = buildPathToBundle(registry);

  // Build set of registered paths (absolute form) for fast membership checks.
  // Both forms use the canonical repo root so comparisons against realpath
  // output match consistently (cr-other-9e5b301f).
  const registeredAbsPaths = new Set();
  const registeredRelPaths = new Set();
  for (const { entry } of iterateArtifactEntries(registry)) {
    if (typeof entry.path === 'string') {
      registeredAbsPaths.add(resolve(canonicalRepoRoot, entry.path));
      registeredRelPaths.add(entry.path);
    }
  }

  // Collect the mjs artifacts to parse.
  const mjsArtifacts = [];
  for (const { category, id, entry } of iterateArtifactEntries(registry)) {
    if (typeof entry.path === 'string' && entry.path.endsWith('.mjs')) {
      mjsArtifacts.push({ category, id, path: entry.path, absPath: resolve(canonicalRepoRoot, entry.path) });
    }
  }

  const parseErrored = new Set();
  let parse_error_count = 0;
  let dynamic_warning_count = 0;

  // Pass 1: parse every .mjs and extract specifiers.
  const parsedSpecifiers = new Map(); // absPath -> { specifiers, importerBundle }
  for (const art of mjsArtifacts) {
    let source;
    try {
      source = readFileSync(art.absPath, 'utf-8');
    } catch (err) {
      findings.push({
        rule: 'parse-error',
        file: art.path,
        bundle: pathToBundle.get(art.path) || null,
        importer: null,
        missingImport: null,
        message: `Unreadable: ${err.message}`,
        remediation: 'Check file exists and is readable',
      });
      parseErrored.add(art.absPath);
      parse_error_count += 1;
      continue;
    }

    let ast;
    try {
      ast = acorn.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowAwaitOutsideFunction: true,
        allowHashBang: true,
        locations: true,
      });
    } catch (err) {
      findings.push({
        rule: 'parse-error',
        file: art.path,
        bundle: pathToBundle.get(art.path) || null,
        importer: null,
        missingImport: null,
        line: err.loc?.line ?? null,
        column: err.loc?.column ?? null,
        message: `Acorn parse error: ${err.message}`,
        remediation: 'Fix syntax error in the file',
      });
      parseErrored.add(art.absPath);
      parse_error_count += 1;
      continue;
    }

    const { specifiers, dynamicWarnings } = extractRelativeSpecifiers(ast);
    dynamic_warning_count += dynamicWarnings;
    parsedSpecifiers.set(art.absPath, {
      specifiers,
      path: art.path,
      importerBundle: pathToBundle.get(art.path) || null,
    });
  }

  // Pass 2: resolve each specifier and classify.
  for (const [importerAbsPath, { specifiers, path: importerRelPath, importerBundle }] of parsedSpecifiers.entries()) {
    for (const specifier of specifiers) {
      const targetAbsPath = resolveRelativeSpecifier(specifier, importerAbsPath);

      if (!targetAbsPath) {
        findings.push({
          rule: 'import-target-missing',
          file: importerRelPath,
          bundle: importerBundle,
          importer: importerRelPath,
          missingImport: specifier,
          remediation: `Create the missing file or update the import to point at an existing artifact`,
        });
        continue;
      }

      // Apply realpath + sep-suffixed containment (REQ-017).
      let resolvedPath;
      try {
        resolvedPath = assertContainment(targetAbsPath, claudeRoot);
      } catch (err) {
        if (err instanceof PathEscapeError) {
          findings.push({
            rule: 'path-escape',
            file: importerRelPath,
            bundle: importerBundle,
            importer: importerRelPath,
            missingImport: specifier,
            target: err.resolved,
            message: err.message,
            remediation: `Ensure the imported file lies within ${claudeRoot}`,
          });
        } else if (err && err.code === 'ENOENT') {
          findings.push({
            rule: 'import-target-missing',
            file: importerRelPath,
            bundle: importerBundle,
            importer: importerRelPath,
            missingImport: specifier,
            remediation: `Create the missing file or update the import`,
          });
        } else {
          // Unknown realpath/containment failure: wrap in a typed error class
          // with a structured `error_code` so downstream telemetry can
          // distinguish this from legitimate missing-file cases.
          // Spec: sg-sync-registry-gaps cr-error-handling-1b8fe042.
          const wrapped = new ImportResolutionUnknownError({
            specifier,
            importerPath: importerRelPath,
            cause: err,
          });
          findings.push({
            rule: 'import-target-missing',
            file: importerRelPath,
            bundle: importerBundle,
            importer: importerRelPath,
            missingImport: specifier,
            error_code: wrapped.error_code,
            message: wrapped.message,
          });
        }
        continue;
      }

      // If the target itself parse-errored earlier, emit a distinct finding.
      if (parseErrored.has(resolvedPath)) {
        findings.push({
          rule: 'import-target-unresolvable',
          file: importerRelPath,
          bundle: importerBundle,
          importer: importerRelPath,
          missingImport: specifier,
          target: toRepoRel(resolvedPath, canonicalRepoRoot),
          remediation: `Fix the parse error in the import target, then re-run`,
        });
        continue;
      }

      const targetRelPath = toRepoRel(resolvedPath, canonicalRepoRoot);

      // Whitelist hit = test-leaf-violation (registered non-test importing a
      // test/fixture file is a layering error).
      if (matchesAnyGlob(targetRelPath, WHITELIST_GLOBS)) {
        findings.push({
          rule: 'test-leaf-violation',
          file: importerRelPath,
          bundle: importerBundle,
          importer: importerRelPath,
          missingImport: specifier,
          target: targetRelPath,
          remediation: `Test and fixture files are leaves; move shared helpers out of __tests__/ or __fixtures__/`,
        });
        continue;
      }

      // Registered?
      if (!registeredRelPaths.has(targetRelPath) && !registeredAbsPaths.has(resolvedPath)) {
        findings.push({
          rule: 'import-unregistered',
          file: importerRelPath,
          bundle: importerBundle,
          importer: importerRelPath,
          missingImport: targetRelPath,
          remediation: `Register ${targetRelPath} in .claude/metaclaude-registry.json or add to orphans[]`,
        });
        continue;
      }

      // Cross-bundle closure.
      const importeeBundle = pathToBundle.get(targetRelPath) || null;
      if (!closureAllowed(importerBundle, importeeBundle)) {
        findings.push({
          rule: 'cross-bundle-closure',
          file: importerRelPath,
          bundle: importerBundle,
          importer: importerRelPath,
          missingImport: targetRelPath,
          target: targetRelPath,
          importeeBundle,
          remediation: `Move the importee to an ancestor bundle of ${importerBundle}, or raise the importer to a descendant bundle of ${importeeBundle}`,
        });
      }
    }
  }

  const duration_ms = Math.round(performance.now() - start);
  return {
    findings,
    duration_ms,
    parse_error_count,
    dynamic_warning_count,
    scanned: mjsArtifacts.length,
  };
}

function toRepoRel(absPath, repoRoot) {
  // Both sides are expected to already be absolute; compute relative form.
  const rel = absPath.startsWith(repoRoot + pathSep)
    ? absPath.slice(repoRoot.length + 1)
    : absPath;
  return rel.split(pathSep).join('/');
}
