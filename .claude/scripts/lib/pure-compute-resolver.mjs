/**
 * TypeScript Path Alias Resolver for Pure-Compute Static Check
 *
 * Resolves import specifiers to absolute file paths:
 *   - Relative specifiers (`./foo`, `../bar`) against a `fromFile` directory
 *   - tsconfig path-alias specifiers (`@app/bar`) via `compilerOptions.paths`
 *   - `baseUrl` honored for alias resolution
 *   - `node:` prefix preserved (caller strips for blocklist lookup)
 *   - Bare node builtins / node_modules left for caller to classify
 *
 * Graceful degradation (EC-PCC-2):
 *   - Missing tsconfig -> falls back to relative + absolute resolution
 *   - Malformed tsconfig -> loader warning emitted, alias map treated as empty
 *   - Unresolvable alias -> returns null; caller emits `<resolution-failed>`
 *
 * Path-containment enforcement (SEC-TRAVERSAL-001, spec.md L314):
 *   - Every candidate path (relative, absolute, alias) passes through
 *     `assertContainment` (realpath + strict prefix check) against the walker-
 *     supplied `projectRoot`. Candidates that escape the root return null,
 *     flowing through the existing fail-closed path (`<resolution-failed>`).
 *   - Defeats wildcard-capture and relative-specifier escapes. For example,
 *     tsconfig paths `{"@bad/*": ["./src/*"]}` + import `@bad/../../../../etc/passwd`
 *     yields captured `../../../../etc/passwd` and substituted
 *     `./src/../../../../etc/passwd`; `node:path#resolve()` climbs out of
 *     baseUrl; assertContainment throws PathEscapeError; resolver returns null.
 *     The same mechanism handles `import '../../../../../etc/passwd'` from an
 *     entry point.
 *
 * Returns `null` when no candidate resolves so the caller (walker) can emit a
 * structured `<resolution-failed>` violation per AC2.3 / AC2.7 / AC2.8.
 *
 * Docs: .claude/docs/PURE-COMPUTE-CHECK-API.md
 * Requirements: REQ-F-011 (TS path aliases; graceful degradation)
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';

import { assertContainment, PathEscapeError } from './path-containment.mjs';

// =============================================================================
// Constants
// =============================================================================

/**
 * Resolver extension precedence (as-002 task list).
 *
 * Order matters: TypeScript source (.ts, .tsx) tried before built JS (.js)
 * so fixture-heavy suites favor the source file when both exist.
 */
export const RESOLVER_EXTENSIONS = ['.mjs', '.ts', '.tsx', '.js', '.jsx', '.json'];

/** Index-file names to try when a specifier resolves to a directory. */
const INDEX_CANDIDATES = RESOLVER_EXTENSIONS.map((ext) => `index${ext}`);

// =============================================================================
// tsconfig Loader (AC2.4, AC2.5, AC2.7, AC2.8)
// =============================================================================

/**
 * Shape returned by `loadTsconfig`.
 *
 * `paths` is the literal `compilerOptions.paths` map, e.g.
 * `{ '@app/*': ['./src/app/*'] }`. `baseUrl` is the absolute directory that
 * `paths` are resolved against (tsconfig dir + `compilerOptions.baseUrl`).
 */

/**
 * Load and parse a tsconfig.json, returning a normalized model.
 *
 * Graceful degradation (AC2.5, AC2.7, AC2.8):
 *   - tsconfigPath undefined OR missing file -> returns empty model, no throw
 *   - malformed JSON / missing compilerOptions -> returns empty model, warn
 *   - valid tsconfig -> returns {paths, baseUrl}
 *
 * @param {string|undefined} tsconfigPath - Absolute tsconfig.json path
 * @param {{warn?: (message: string) => void}} [options]
 * @returns {{paths: Record<string, string[]>, baseUrl: string|null, path: string|null}}
 */
export function loadTsconfig(tsconfigPath, options = {}) {
  const warn = options.warn || (() => {});

  if (!tsconfigPath) {
    // AC2.7: omitted/undefined path -> silent graceful degradation, no warning.
    return { paths: {}, baseUrl: null, path: null };
  }

  if (!existsSync(tsconfigPath)) {
    // AC2.8: missing file -> single loader diagnostic, no throw.
    warn(`tsconfig not found at ${tsconfigPath}; relative resolution only`);
    return { paths: {}, baseUrl: null, path: null };
  }

  let raw;
  try {
    raw = readFileSync(tsconfigPath, 'utf-8');
  } catch (err) {
    warn(`tsconfig read failed: ${err.message}`);
    return { paths: {}, baseUrl: null, path: null };
  }

  let parsed;
  try {
    // tsconfig files may contain comments; strip them conservatively. This is
    // a best-effort parser, not a full jsonc implementation.
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    warn(`tsconfig parse failed: ${err.message}`);
    return { paths: {}, baseUrl: null, path: tsconfigPath };
  }

  const compilerOptions = (parsed && parsed.compilerOptions) || {};
  const tsconfigDir = dirname(tsconfigPath);
  const baseUrl = compilerOptions.baseUrl
    ? resolve(tsconfigDir, compilerOptions.baseUrl)
    : tsconfigDir;
  const paths = compilerOptions.paths && typeof compilerOptions.paths === 'object'
    ? compilerOptions.paths
    : {};

  return { paths, baseUrl, path: tsconfigPath };
}

/**
 * Strip `//` line comments and `/* *\/` block comments from a JSON string.
 *
 * Conservative: preserves `//` / `/*` that appear inside string literals.
 *
 * @param {string} text
 * @returns {string}
 */
function stripJsonComments(text) {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (escapeNext) {
      result += c;
      escapeNext = false;
      continue;
    }

    if (inString) {
      result += c;
      if (c === '\\') escapeNext = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        result += c;
      }
      continue;
    }

    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      result += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    result += c;
  }

  return result;
}

// =============================================================================
// Specifier Resolution (AC2.1, AC2.2, AC2.3, AC2.4, AC2.6)
// =============================================================================

/**
 * Resolve an import specifier to an absolute file path, or null if no
 * candidate exists on disk OR escapes the containment root.
 *
 * Order (AC2.6):
 *   1. Relative specifier (`./`, `../`) -> resolve against `fromFile` dir.
 *   2. Absolute specifier -> try as-is against RESOLVER_EXTENSIONS.
 *   3. tsconfig paths alias match -> try each mapping in declaration order.
 *   4. No candidate -> null.
 *
 * SEC-TRAVERSAL-001: when `tsconfig.projectRoot` is populated by the walker,
 * every candidate is passed through `assertContainment` before it is returned.
 * Paths that escape the root are rejected (return null). This closes the gap
 * where a wildcard capture like `../../../../etc/passwd` would otherwise be
 * resolved outside baseUrl. The null return flows through the existing fail-
 * closed path: walker emits `<resolution-failed>` for escape attempts.
 *
 * Bare node builtins (`fs`, `net`, `node:fs`, `child_process`) are NOT
 * resolved here -- caller classifies them via the blocklist matcher (as-005).
 *
 * @param {string} specifier - The import specifier text
 * @param {string} fromFile - Absolute path of the importing file
 * @param {{paths: Record<string, string[]>, baseUrl: string|null, projectRoot?: string|null}} tsconfig
 * @returns {string|null} Absolute resolved path or null
 */
export function resolveSpecifier(specifier, fromFile, tsconfig) {
  if (typeof specifier !== 'string' || specifier.length === 0) return null;

  const cfg = tsconfig || { paths: {}, baseUrl: null };
  const projectRoot = cfg.projectRoot || null;

  // 1. Relative imports.
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const base = dirname(fromFile);
    const abs = resolve(base, specifier);
    const resolved = resolveWithExtensions(abs);
    return containOrNull(resolved, projectRoot);
  }

  // 2. Absolute imports.
  if (isAbsolute(specifier)) {
    const resolved = resolveWithExtensions(specifier);
    return containOrNull(resolved, projectRoot);
  }

  // 3. tsconfig paths alias match (AC2.2, AC2.6).
  const aliasResolved = resolveAlias(specifier, cfg);
  if (aliasResolved) return aliasResolved;

  // 4. Bare specifier (node builtin or node_modules) -- caller handles.
  //    The walker will emit <resolution-failed> if this is a user-declared
  //    alias that didn't match a tsconfig path entry.
  return null;
}

/**
 * Containment gate: realpath + strict-prefix check against `projectRoot`.
 *
 * SEC-TRAVERSAL-001 / spec.md L314 mandate: every resolver return is gated
 * through `assertContainment` to prevent `..`-relative / wildcard-capture
 * escapes from reaching the walker's `readFileSync`. On escape we swallow the
 * `PathEscapeError` and return null so the caller's existing fail-closed path
 * (`<resolution-failed>` violation, fail verdict) triggers. We do NOT re-throw
 * or leak the canonicalized resolved path, which could expose filesystem
 * layout details in diagnostics.
 *
 * If `projectRoot` is null (no containment root available — e.g. degenerate
 * zero-entry-point input), the gate is a no-op and callers receive the
 * resolver's raw candidate.
 *
 * @param {string|null} candidate - Absolute resolver candidate or null
 * @param {string|null} projectRoot - Absolute containment root or null
 * @returns {string|null} Canonicalized candidate inside root, or null on escape
 */
function containOrNull(candidate, projectRoot) {
  if (!candidate) return null;
  if (!projectRoot) return candidate;
  try {
    return assertContainment(candidate, projectRoot);
  } catch (err) {
    if (err instanceof PathEscapeError) return null;
    // Other realpath errors (ENOENT on broken symlink, EACCES) treated as
    // unresolvable. Fail-closed: caller sees null and emits <resolution-failed>.
    return null;
  }
}

/**
 * Try to resolve an absolute path prefix against RESOLVER_EXTENSIONS.
 *
 * Order:
 *   1. Exact match if file exists and is a file.
 *   2. `<prefix><ext>` for each ext in RESOLVER_EXTENSIONS.
 *   3. `<prefix>/index<ext>` for each ext (if prefix is a directory).
 *
 * @param {string} absPath - Absolute path with or without extension
 * @returns {string|null}
 */
function resolveWithExtensions(absPath) {
  // Exact file match.
  if (existsSync(absPath) && isRegularFile(absPath)) {
    return absPath;
  }
  // Try each extension.
  for (const ext of RESOLVER_EXTENSIONS) {
    const candidate = absPath + ext;
    if (existsSync(candidate) && isRegularFile(candidate)) {
      return candidate;
    }
  }
  // Try directory/index.*
  if (existsSync(absPath) && isDirectory(absPath)) {
    for (const indexName of INDEX_CANDIDATES) {
      const candidate = join(absPath, indexName);
      if (existsSync(candidate) && isRegularFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Apply tsconfig paths alias rules, trying each candidate in declaration order.
 *
 * Supports wildcards in the pattern (`@app/*`) and the substitution template
 * (`./src/app/*`).
 *
 * SEC-TRAVERSAL-001: each candidate is containment-checked against
 * `cfg.projectRoot` (falls back to `cfg.baseUrl` when projectRoot absent) via
 * `containOrNull`. An escaping candidate is silently dropped; the loop
 * continues with remaining candidates so that a legitimate fallback mapping
 * can still resolve.
 *
 * @param {string} specifier
 * @param {{paths: Record<string, string[]>, baseUrl: string|null, projectRoot?: string|null}} cfg
 * @returns {string|null}
 */
function resolveAlias(specifier, cfg) {
  if (!cfg.paths || !cfg.baseUrl) return null;

  // Containment root for alias expansion: prefer walker-supplied projectRoot,
  // fall back to baseUrl (tsconfig-declared project boundary). baseUrl is the
  // correct fallback because alias templates are resolved relative to it.
  const projectRoot = cfg.projectRoot || cfg.baseUrl;

  // Collect exact and wildcard matches; prefer exact-match first, then most
  // specific wildcard (longest non-wildcard prefix).
  const exactKey = cfg.paths[specifier];
  if (Array.isArray(exactKey)) {
    for (const candidate of exactKey) {
      const absCandidate = resolve(cfg.baseUrl, candidate);
      const resolved = containOrNull(resolveWithExtensions(absCandidate), projectRoot);
      if (resolved) return resolved;
    }
  }

  // Wildcard match: pattern of form "<prefix>*" or "<prefix>*<suffix>".
  const wildcardMatches = [];
  for (const pattern of Object.keys(cfg.paths)) {
    if (!pattern.includes('*')) continue;
    const starIdx = pattern.indexOf('*');
    const prefix = pattern.slice(0, starIdx);
    const suffix = pattern.slice(starIdx + 1);
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix) &&
        specifier.length >= prefix.length + suffix.length) {
      const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      wildcardMatches.push({ pattern, prefix, captured, suffix });
    }
  }

  // Longer prefixes are more specific; sort descending.
  wildcardMatches.sort((a, b) => b.prefix.length - a.prefix.length);

  for (const match of wildcardMatches) {
    const templates = cfg.paths[match.pattern];
    if (!Array.isArray(templates)) continue;
    for (const template of templates) {
      // Substitute captured for `*` in template.
      const substituted = template.replace('*', match.captured);
      const absCandidate = resolve(cfg.baseUrl, substituted);
      const resolved = containOrNull(resolveWithExtensions(absCandidate), projectRoot);
      if (resolved) return resolved;
    }
  }

  return null;
}

/** Safe file-type check that tolerates transient fs errors. */
function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Safe directory-type check. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
