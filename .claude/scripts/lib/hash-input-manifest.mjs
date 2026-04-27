/**
 * hash_input_manifest Content-Hash Computation Helper
 *
 * Pure helper that resolves each entry of a `hash_input_manifest` array, reads
 * the underlying bytes, and returns a deterministic SHA-256 hex digest.
 *
 * Manifest entries come from `PerGateThresholdTable[gate].hash_input_manifest`
 * (see `.claude/scripts/lib/per-gate-threshold-table.mjs`). Entry shapes:
 *
 *   1. Literal file path:    "spec.md", "requirements.md", "manifest.json"
 *   2. Single-`*` glob:      ".claude/specs/groups/<id>/atomic/*.md"
 *                            (`<id>` substituted from context.spec_group_id)
 *   3. Git-diff descriptor:  "git-diff:<branch-base>..HEAD"
 *                            (`<branch-base>` substituted from context.branch_base)
 *
 * Determinism is required for attestation (REQ-001): two passes against
 * byte-identical inputs must produce the same hash, so a stable concatenation
 * order (manifest-order for entries, lexicographic for glob expansion) and a
 * stable separator are mandatory.
 *
 * Implements: REQ-001, AC12.1..AC12.4
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning / as-012
 *   - AC12.1: array of paths -> SHA-256 hex digest
 *   - AC12.2: glob expands deterministically (sorted) and hashes in order
 *   - AC12.3: "git-diff" descriptor triggers `git diff <range>` and hashes stdout
 *   - AC12.4: missing file throws `HASH_INPUT_MISSING` with offending path
 *
 * Consumer: as-013 wires this into `session-checkpoint.mjs`
 * deriveConvergenceFromEvidence; as-013 also owns EC-7 fallback (hash change
 * between passes -> run another pass without attestation skip). This module
 * is pure computation -- no EC-7 handling.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// =============================================================================
// Constants
// =============================================================================

/**
 * Stable separator placed between resolved-input buffers before hashing.
 *
 * A newline is a legitimate character inside any real input file, so a
 * content-bearing separator could allow two distinct manifest expansions to
 * collide. Instead we inject a length-prefixed NUL record boundary:
 *   `\0<bytes>\0<byteLength>\n`
 * per concatenation step in `concatForDigest`. This constant is the single-
 * byte record separator itself; the length prefix is assembled inline.
 *
 * @type {Buffer}
 */
const RECORD_SEPARATOR = Buffer.from([0x00]);

/**
 * Prefix identifying a git-diff descriptor manifest entry.
 *
 * Matches the descriptor stored in PerGateThresholdTable for code-review /
 * security gates: "git-diff:<branch-base>..HEAD". The `<branch-base>`
 * placeholder is resolved from `context.branch_base` before invocation.
 *
 * @type {string}
 */
const GIT_DIFF_DESCRIPTOR_PREFIX = 'git-diff:';

/**
 * Placeholder tokens resolved from the caller-provided `context` argument.
 * Keeping these as a lookup table documents every placeholder the helper
 * understands and makes future additions explicit.
 *
 * @type {Record<string, "spec_group_id" | "branch_base">}
 */
const CONTEXT_PLACEHOLDERS = Object.freeze({
  '<id>': 'spec_group_id',
  '<branch-base>': 'branch_base',
});

// =============================================================================
// Error class
// =============================================================================

/**
 * Thrown when a manifest entry cannot be resolved (missing file, unresolved
 * placeholder, failed git invocation, or unrecognized descriptor shape).
 *
 * Error `code` values:
 *   - `HASH_INPUT_MISSING`       -- file path did not resolve to an existing
 *                                   regular file (AC12.4). `.path` carries
 *                                   the offending manifest entry (post
 *                                   placeholder substitution).
 *   - `HASH_INPUT_UNRESOLVED`    -- manifest entry still contains a `<...>`
 *                                   placeholder after context substitution.
 *   - `HASH_INPUT_GIT_FAILED`    -- `git diff <range>` invocation failed;
 *                                   `.cause` carries the underlying error.
 *   - `HASH_INPUT_INVALID_ENTRY` -- entry is not a string or is an empty
 *                                   string.
 */
export class HashInputError extends Error {
  /**
   * @param {string} message
   * @param {"HASH_INPUT_MISSING"|"HASH_INPUT_UNRESOLVED"|"HASH_INPUT_GIT_FAILED"|"HASH_INPUT_INVALID_ENTRY"} code
   * @param {{ path?: string, cause?: unknown }} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'HashInputError';
    this.code = code;
    if (details.path !== undefined) this.path = details.path;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

// =============================================================================
// Placeholder + classification helpers
// =============================================================================

/**
 * Substitute `<id>` / `<branch-base>` tokens in a manifest entry using values
 * from `context`. Any unresolved `<...>` token after substitution throws
 * `HASH_INPUT_UNRESOLVED`; silently emitting an unresolved token would let
 * glob expansion match a literal directory named `<id>` and produce a stable
 * but incorrect hash.
 *
 * @param {string} entry   - Raw manifest entry from PerGateThresholdTable.
 * @param {Record<string, string | undefined>} context
 * @returns {string} Entry with placeholders substituted.
 * @throws {HashInputError} HASH_INPUT_UNRESOLVED if a `<...>` token remains.
 */
function substitutePlaceholders(entry, context) {
  let resolved = entry;
  for (const [token, ctxKey] of Object.entries(CONTEXT_PLACEHOLDERS)) {
    if (!resolved.includes(token)) continue;
    const value = context[ctxKey];
    if (typeof value !== 'string' || value.length === 0) continue;
    resolved = resolved.split(token).join(value);
  }
  if (/<[^>]+>/.test(resolved)) {
    throw new HashInputError(
      `Unresolved placeholder in manifest entry: ${resolved}`,
      'HASH_INPUT_UNRESOLVED',
      { path: resolved },
    );
  }
  return resolved;
}

/**
 * Classify a resolved manifest entry.
 *
 * @param {string} entry - Post-substitution manifest entry.
 * @returns {"git-diff" | "glob" | "literal"}
 */
function classifyEntry(entry) {
  if (entry.startsWith(GIT_DIFF_DESCRIPTOR_PREFIX)) return 'git-diff';
  if (entry.includes('*')) return 'glob';
  return 'literal';
}

// =============================================================================
// Entry resolvers -- each returns Buffer[] in manifest-deterministic order
// =============================================================================

/**
 * Read a single literal file path and return its contents.
 *
 * @param {string} filePath - Post-substitution file path (relative to `cwd`).
 * @param {string} cwd
 * @returns {Buffer} File bytes.
 * @throws {HashInputError} HASH_INPUT_MISSING if the path does not exist or
 *   is not a regular file (AC12.4).
 */
function readLiteral(filePath, cwd) {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.join(cwd, filePath);
  let stats;
  try {
    stats = statSync(absolute);
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      throw new HashInputError(
        `hash_input_manifest entry not found: ${filePath}`,
        'HASH_INPUT_MISSING',
        { path: filePath, cause: err },
      );
    }
    throw err;
  }
  if (!stats.isFile()) {
    throw new HashInputError(
      `hash_input_manifest entry is not a regular file: ${filePath}`,
      'HASH_INPUT_MISSING',
      { path: filePath },
    );
  }
  return readFileSync(absolute);
}

/**
 * Expand a single-`*` glob pattern (e.g. `a/b/*.md`) into a lexicographically
 * sorted list of matching regular files, then read each.
 *
 * Scope: leaf-directory single-`*` patterns only. This is sufficient for the
 * seeded manifests in PerGateThresholdTable
 * (`.claude/specs/groups/<id>/atomic/*.md`). `**`, multiple `*` segments, and
 * character classes are not supported; if encountered they throw
 * HASH_INPUT_INVALID_ENTRY so the caller hears about it rather than silently
 * hashing an empty set.
 *
 * AC12.2: deterministic expansion via `readdirSync` + `.sort()`.
 *
 * @param {string} pattern - Post-substitution glob pattern.
 * @param {string} cwd
 * @returns {Array<{ path: string, bytes: Buffer }>} Sorted matches.
 * @throws {HashInputError} HASH_INPUT_INVALID_ENTRY for unsupported glob shape.
 * @throws {HashInputError} HASH_INPUT_MISSING if the parent directory does
 *   not exist.
 */
function expandGlob(pattern, cwd) {
  const lastSlash = pattern.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? pattern.slice(0, lastSlash) : '.';
  const filePart = lastSlash >= 0 ? pattern.slice(lastSlash + 1) : pattern;

  if (
    dirPart.includes('*') ||
    filePart.indexOf('*') !== filePart.lastIndexOf('*')
  ) {
    throw new HashInputError(
      `Unsupported glob shape (only leaf single-* supported): ${pattern}`,
      'HASH_INPUT_INVALID_ENTRY',
      { path: pattern },
    );
  }

  const starIdx = filePart.indexOf('*');
  const prefix = filePart.slice(0, starIdx);
  const suffix = filePart.slice(starIdx + 1);
  const absoluteDir = path.isAbsolute(dirPart)
    ? dirPart
    : path.join(cwd, dirPart);

  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      throw new HashInputError(
        `hash_input_manifest glob directory not found: ${dirPart}`,
        'HASH_INPUT_MISSING',
        { path: pattern, cause: err },
      );
    }
    throw err;
  }

  const matched = entries
    .filter(
      (dirent) =>
        dirent.isFile() &&
        dirent.name.startsWith(prefix) &&
        dirent.name.endsWith(suffix) &&
        dirent.name.length >= prefix.length + suffix.length,
    )
    .map((dirent) => dirent.name)
    .sort();

  return matched.map((name) => {
    const relPath = dirPart === '.' ? name : `${dirPart}/${name}`;
    return { path: relPath, bytes: readLiteral(relPath, cwd) };
  });
}

/**
 * Invoke `git diff <range>` for a `git-diff:<range>` manifest entry and
 * return stdout bytes. Runs from `cwd`, passes `-c color.ui=never` to
 * suppress ANSI color codes (which would introduce environment-dependent
 * noise in the content-hash), and uses `execFileSync` -- never `exec` with
 * a shell -- to keep the range argument literal even if it ever contains
 * shell-meaningful characters.
 *
 * TODO(assumption): low-confidence. The exact wire shape of the descriptor
 * (`git-diff:<branch-base>..HEAD`) is per as-002 ASM-002 ("descriptor shape
 * deferred"). This helper accepts whatever follows the `git-diff:` prefix
 * verbatim as a git range. Cross-ref: ASM-002 in as-002.
 *
 * @param {string} entry - Full descriptor, e.g. `git-diff:main..HEAD`.
 * @param {string} cwd
 * @returns {Buffer} stdout bytes of `git diff <range>`.
 * @throws {HashInputError} HASH_INPUT_GIT_FAILED on git invocation failure.
 */
function readGitDiff(entry, cwd) {
  const range = entry.slice(GIT_DIFF_DESCRIPTOR_PREFIX.length);
  if (range.length === 0) {
    throw new HashInputError(
      `Empty git-diff range in manifest entry: ${entry}`,
      'HASH_INPUT_INVALID_ENTRY',
      { path: entry },
    );
  }
  try {
    return execFileSync('git', ['-c', 'color.ui=never', 'diff', range], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new HashInputError(
      `git diff ${range} failed: ${err instanceof Error ? err.message : String(err)}`,
      'HASH_INPUT_GIT_FAILED',
      { path: entry, cause: err },
    );
  }
}

// =============================================================================
// Concatenation + digest
// =============================================================================

/**
 * Build a length-prefixed record stream from resolved buffers and return its
 * SHA-256 hex digest. Length-prefix framing makes the digest collision-free
 * with respect to manifest-entry boundaries: two different splits of the
 * same byte stream cannot hash to the same value because each record
 * contributes its byte length.
 *
 * Record format per input:
 *   RECORD_SEPARATOR || ascii-decimal(byteLength) || ":" || bytes
 *
 * @param {Array<{ label: string, bytes: Buffer }>} records - In hash order.
 * @returns {string} 64-char lowercase SHA-256 hex digest.
 */
function digestRecords(records) {
  const hasher = createHash('sha256');
  for (const { bytes } of records) {
    hasher.update(RECORD_SEPARATOR);
    hasher.update(`${bytes.length}:`, 'utf8');
    hasher.update(bytes);
  }
  return hasher.digest('hex');
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Compute the per-gate content-hash for the given `hash_input_manifest`.
 *
 * Usage:
 *
 *     import { PerGateThresholdTable } from './per-gate-threshold-table.mjs';
 *     import { computeHashInputManifest } from './hash-input-manifest.mjs';
 *
 *     const entry = PerGateThresholdTable['unifier'];
 *     const { content_hash, file_paths } = computeHashInputManifest(entry, {
 *       spec_group_id: 'sg-foo',
 *       cwd: process.cwd(),
 *     });
 *
 * Resolution order (deterministic, per AC12.1..12.3):
 *   1. For each manifest entry, in array order:
 *      - Substitute `<id>` / `<branch-base>` placeholders from `context`.
 *      - Classify: git-diff descriptor / glob / literal.
 *      - Glob: expand via `readdirSync` sorted lexicographically; read each
 *        matched file (AC12.2).
 *      - Literal: read directly (AC12.1); missing file throws
 *        HASH_INPUT_MISSING (AC12.4).
 *      - Git-diff: invoke `git diff <range>` and capture stdout (AC12.3).
 *   2. Concatenate all resolved byte streams via length-prefixed records,
 *      hash with SHA-256, return hex digest plus the full ordered list of
 *      file paths / descriptors that contributed.
 *
 * @param {{ hash_input_manifest: readonly string[], attestation_mode?: string }} gateEntry
 *   A single PerGateThresholdTable entry. `attestation_mode` is ignored here
 *   (that branch lives in as-013); the helper is pure w.r.t. manifest
 *   resolution. If `hash_input_manifest` is empty, returns the SHA-256 of an
 *   empty stream.
 * @param {{
 *   spec_group_id?: string,
 *   branch_base?: string,
 *   cwd?: string,
 * }} [context] - Placeholder values and working directory. `cwd` defaults
 *   to `process.cwd()`.
 * @returns {{ content_hash: string, file_paths: string[] }}
 *   `content_hash` is the 64-char lowercase SHA-256 hex. `file_paths` is the
 *   ordered list of resolved literals, glob-expansion matches, and git-diff
 *   descriptors that contributed to the hash -- useful for diagnostics when
 *   EC-7 (hash change between passes) triggers in as-013.
 * @throws {HashInputError} See class JSDoc for code values.
 * @throws {TypeError} If `gateEntry.hash_input_manifest` is not an array of
 *   strings.
 */
export function computeHashInputManifest(gateEntry, context = {}) {
  if (
    !gateEntry ||
    typeof gateEntry !== 'object' ||
    !Array.isArray(gateEntry.hash_input_manifest)
  ) {
    throw new TypeError(
      'computeHashInputManifest: gateEntry.hash_input_manifest must be an array',
    );
  }
  const manifest = gateEntry.hash_input_manifest;
  const cwd = context.cwd ?? process.cwd();
  const resolvedContext = {
    spec_group_id: context.spec_group_id,
    branch_base: context.branch_base,
  };

  /** @type {Array<{ label: string, bytes: Buffer }>} */
  const records = [];
  /** @type {string[]} */
  const filePaths = [];

  for (const rawEntry of manifest) {
    if (typeof rawEntry !== 'string' || rawEntry.length === 0) {
      throw new HashInputError(
        `Invalid manifest entry: ${JSON.stringify(rawEntry)}`,
        'HASH_INPUT_INVALID_ENTRY',
        { path: String(rawEntry) },
      );
    }
    const resolved = substitutePlaceholders(rawEntry, resolvedContext);
    const kind = classifyEntry(resolved);

    if (kind === 'git-diff') {
      const bytes = readGitDiff(resolved, cwd);
      records.push({ label: resolved, bytes });
      filePaths.push(resolved);
      continue;
    }
    if (kind === 'glob') {
      const matches = expandGlob(resolved, cwd);
      for (const match of matches) {
        records.push({ label: match.path, bytes: match.bytes });
        filePaths.push(match.path);
      }
      continue;
    }
    // literal
    const bytes = readLiteral(resolved, cwd);
    records.push({ label: resolved, bytes });
    filePaths.push(resolved);
  }

  return {
    content_hash: digestRecords(records),
    file_paths: filePaths,
  };
}
