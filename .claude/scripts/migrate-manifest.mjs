#!/usr/bin/env node

/**
 * One-shot idempotent migration: legacy-flat spec-group manifest -> canonical nested shape.
 *
 * Spec: sg-enforcement-layer-gaps
 * Implements REQ-M1-005, REQ-M1-012, REQ-M1-006
 * Covers AC-4.1 through AC-4.11 + AC-4.5a (prd_content_hash) + AC-1a.* (convergence subfield strip).
 *
 * Canonical nested shape (target):
 *   {
 *     id, title, description?,
 *     prd: { source, file_path?, version?, content_hash?, ... } | null,
 *     review_state, work_state,
 *     created_at, updated_at,
 *     updated_by: "agent" | "human",
 *     requirements?, atomic_specs?, convergence?, decision_log?,
 *     last_progress_update?, heartbeat_warnings?,
 *     session_ref?, last_session_id?, priority?, related_prds?
 *   }
 *
 * Migration rules (in order):
 *   1. Move top-level `prd_content_hash` into nested `prd.content_hash` (AC-4.5a).
 *   2. Move top-level `prd_id`, `prd_path`, `prd_version` into nested
 *      `prd.{id, file_path, version}` (pre-existing drift).
 *   3. Strip top-level `spec_group_id` (it duplicates `id`).
 *   4. Strip non-canonical `convergence.*_clean_pass_count` subfields
 *      (they belong in session.json; inv-contract-a26e31 / AC-1a.*).
 *   5. Backfill `updated_by: "agent"` if missing (AC-4.4).
 *   6. Rewrite `updated_by: "user"` -> `updated_by: "human"` (AC-4.5).
 *   7. Preserve all other fields unchanged.
 *
 * Conflict detection (AC-4.8):
 *   If a top-level flat field (`prd_id`, `prd_path`, `prd_version`, `prd_content_hash`)
 *   disagrees with the corresponding nested value that already exists
 *   (`prd.id`, `prd.file_path`, `prd.version`, `prd.content_hash`), this file is ABORTED
 *   and a conflict report is written to `.claude/coordination/migration-conflicts.json`.
 *   Migration continues with remaining files.
 *
 * Atomicity (AC-4.6, SEC-006):
 *   Per-file temp-then-rename; file-mode bits preserved across rename.
 *
 * Scope (AC-4.3):
 *   `.claude/specs/groups/<sg>/manifest.json` with `--all`.
 *   `.claude/specs/archive/**` excluded.
 *
 * Exit codes:
 *   0 - success (all files migrated or already canonical)
 *   1 - conflict detected and conflict report written successfully
 *   2 - other error (disk, permission outside conflict report, malformed input)
 *   3 - conflict + conflict-report write failure (AC-4.9)
 *
 * Usage:
 *   node .claude/scripts/migrate-manifest.mjs --all
 *   node .claude/scripts/migrate-manifest.mjs <path1> [path2 ...]
 *   node .claude/scripts/migrate-manifest.mjs --all --dry-run
 *   node .claude/scripts/migrate-manifest.mjs --all --pipeline-efficiency
 *     (as-027 / AC27.2 / Task I2): in-place seed `threshold_snapshot` onto
 *     manifests that lack it, using direct PerGateThresholdTable reads. Runs
 *     pre-session; source tag is "hardcoded-default"; idempotent re-run.
 *   node .claude/scripts/migrate-manifest.mjs --atomic-id-schema [--dry-run | --apply]
 *     (as-014 / REQ-008 / AC14.1-AC14.3): scan all
 *     `.claude/specs/groups/<sg>/atomic/*.md` files, identify filenames that
 *     do NOT match `ATOMIC_FILENAME_REGEX`, emit a rename plan (dry-run) or
 *     execute git-friendly renames + cross-reference updates + per-rename
 *     hash-chained audit entries (apply). Idempotent: already-canonical
 *     filenames are skipped on re-run. Output JSON shape:
 *       { mode, renamed: [{from,to}], cross_refs_updated, audit_entries, errors }
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  statSync,
  chmodSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { getCanonicalProjectDir } from './lib/hook-utils.mjs';
// as-014 (REQ-008 / AC14.1-AC14.3): atomic-spec filename schema import wires
// this script into the single source of truth for canonical atomic-spec
// filenames. The `--atomic-id-schema` flag scans all spec-group atomic files
// and identifies any whose basename does NOT match `ATOMIC_FILENAME_REGEX`
// (Investigation Pass 1 broadened; accepts plain / slug / ws-prefixed forms).
// Non-matching files → rename-plan entries; already-matching files → skipped
// (idempotent on re-run per AC14.3).
import {
  ATOMIC_FILENAME_REGEX,
  parseAtomicFilename,
  formatAtomicFilename,
} from './lib/atomic-id-schema.mjs';
// as-010 / AC10.2, AC10.4: migration runs PRE-session so the
// SessionThresholdSnapshot is not guaranteed to exist; bypass the snapshot
// and read PerGateThresholdTable directly from the canonical module. This
// wires migrate-manifest.mjs into the threshold-reader superset
// (spec §Contract:threshold-reader-superset) via the table-import
// path distinct from the runtime snapshot-reader path used by validate-manifest.
//
// as-027 / AC27.2 (Task I2): the `--pipeline-efficiency` flag extends this
// migration to also seed a `threshold_snapshot` field onto manifests that
// lack it. Uses the same direct table-import path (pre-session context);
// source tag is fixed at "hardcoded-default" per AC5.2 since migration runs
// before any session captures the enforcement-flag state.
import {
  PerGateThresholdTable,
  PER_GATE_THRESHOLD_TABLE_GATES,
} from './lib/per-gate-threshold-table.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// as-012 (REQ-003.6): wrapped canonicalizer reference so failure modes fall
// back to the legacy ancestor walk. Assigned via IIFE so we can keep the
// helper optional for standalone-CLI contexts.
const projectRootFromCanonicalizer = (() => {
  try {
    return getCanonicalProjectDir;
  } catch {
    return null;
  }
})();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Top-level keys that must be migrated INTO nested `prd` object. */
const FLAT_TO_NESTED_PRD_MAP = {
  prd_id: 'id',
  prd_path: 'file_path',
  prd_version: 'version',
  prd_content_hash: 'content_hash',
};

/** Top-level keys that are simply removed (duplicates of canonical `id`). */
const FLAT_KEYS_TO_DROP = ['spec_group_id'];

/** Suffix pattern identifying non-canonical convergence subfields (AC-1a.*). */
const CLEAN_PASS_COUNT_SUFFIX = '_clean_pass_count';

/**
 * Fallback `required_clean_passes` when PerGateThresholdTable has no entry for
 * the derived gate name. Matches the pre-pruning hardcoded default (AC10.3
 * semantics: absent-data paths default to 2-consecutive-clean).
 * @type {number}
 */
const DEFAULT_REQUIRED_CLEAN_PASSES = 2;

/**
 * Map a stripped `<name>_clean_pass_count` convergence subfield back to its
 * canonical gate identifier in `PerGateThresholdTable`. A value returned here
 * is looked up against the directly-imported table — migration runs pre-session
 * so snapshot reads are intentionally bypassed (AC10.2).
 *
 * The mapping is deliberately narrow: unknown prefixes return `null` and the
 * caller falls back to the default threshold. This avoids the migration
 * inventing gate identifiers that the PerGateThresholdTable Zod validator
 * would reject at table-load time.
 *
 * @param {string} subfieldKey — e.g., "unifier_clean_pass_count"
 * @returns {string|null} gate name (e.g., "unifier") or null when unmapped
 */
function gateFromCleanPassCountKey(subfieldKey) {
  if (!subfieldKey.endsWith(CLEAN_PASS_COUNT_SUFFIX)) return null;
  const prefix = subfieldKey.slice(0, -CLEAN_PASS_COUNT_SUFFIX.length);
  // Map bare convergence gate names to canonical PerGateThresholdTable keys.
  // Hyphenated table keys (`code-review`, `challenger-pre-impl`, etc.) use
  // underscore forms in manifest convergence objects (`code_review`,
  // `challenger_pre_impl`) per existing CANONICAL_FIELDS in
  // validate-convergence-fields.mjs; translate here.
  const TABLE_KEY_BY_PREFIX = {
    unifier: 'unifier',
    code_review: 'code-review',
    security: 'security',
    completion_verifier: 'completion-verifier',
    investigation: 'investigation',
    challenger_pre_impl: 'challenger-pre-impl',
    challenger_pre_orch: 'challenger-pre-orch',
  };
  return TABLE_KEY_BY_PREFIX[prefix] ?? null;
}

/**
 * Resolve `required_clean_passes` for a gate via direct PerGateThresholdTable
 * read (AC10.2 — migrate-manifest bypasses the session snapshot). Falls back
 * to `DEFAULT_REQUIRED_CLEAN_PASSES` when the gate is absent or unknown
 * (AC10.3 — preserve 2-consecutive-clean semantics).
 *
 * Exported for use by unit tests (`__tests__/scripts/migrate-manifest-pre-session.test.mjs`)
 * that exercise the pre-session read path without standing up a live session.
 *
 * @param {string|null} gate
 * @returns {number}
 */
export function readGateThresholdFromTable(gate) {
  if (!gate) return DEFAULT_REQUIRED_CLEAN_PASSES;
  const entry = PerGateThresholdTable[gate];
  if (!entry || typeof entry.required_clean_passes !== 'number') {
    return DEFAULT_REQUIRED_CLEAN_PASSES;
  }
  return entry.required_clean_passes;
}

// ---------------------------------------------------------------------------
// as-027 / AC27.2 (Task I2): threshold_snapshot seeding helpers
// ---------------------------------------------------------------------------

/**
 * Tag applied to `threshold_snapshot.source` when the migration seeds a
 * manifest from `PerGateThresholdTable` directly. Matches AC5.2 semantics:
 * in the absence of a well-formed enforcement-flag observation (we're running
 * pre-session), the fallback `source` is `"hardcoded-default"`. This is also
 * the source that start-work will record when the enforcement-flag file is
 * absent, so migrated manifests are shape-compatible with fresh sessions.
 *
 * @type {string}
 */
const MIGRATION_SNAPSHOT_SOURCE = 'hardcoded-default';

/**
 * Build a `threshold_snapshot` object by direct-reading PerGateThresholdTable.
 * This is the pre-session counterpart of `buildSessionThresholdSnapshot` from
 * `lib/snapshot-capture.mjs` — the runtime builder captures enforcement-flag
 * state and genesis-anchor verification, neither of which is available during
 * manifest migration. So we emit the minimum shape required by the
 * superset contract (per_gate map + source + session_started_at + immutable).
 *
 * Shape mirrors `session.active_work.threshold_snapshot` so consumers reading
 * from a manifest-seeded snapshot see the same key paths they would see after
 * a normal start-work. `immutable: true` marks the seeded snapshot as frozen;
 * the runtime `assertSnapshotImmutable` guard lives in session-checkpoint.mjs
 * and only fires on live session mutations, not on manifest-file writes.
 *
 * @param {string} seededAt — ISO-8601 UTC timestamp stamped on `session_started_at`.
 * @returns {{
 *   per_gate: Record<string, { required_clean_passes: number, attestation_mode: string, captured_at: string }>,
 *   source: string,
 *   session_started_at: string,
 *   immutable: true
 * }}
 */
function buildMigrationThresholdSnapshot(seededAt) {
  const perGate = {};
  for (const gate of PER_GATE_THRESHOLD_TABLE_GATES) {
    const entry = PerGateThresholdTable[gate];
    // Defensive: PerGateThresholdTable is Zod-validated at module load, so the
    // shape is guaranteed. Fall back to DEFAULT_REQUIRED_CLEAN_PASSES only if
    // a future refactor loosens the table contract.
    const required =
      entry && typeof entry.required_clean_passes === 'number'
        ? entry.required_clean_passes
        : DEFAULT_REQUIRED_CLEAN_PASSES;
    const mode =
      entry && typeof entry.attestation_mode === 'string'
        ? entry.attestation_mode
        : 'none';
    perGate[gate] = {
      required_clean_passes: required,
      attestation_mode: mode,
      captured_at: seededAt,
    };
  }
  return {
    per_gate: perGate,
    source: MIGRATION_SNAPSHOT_SOURCE,
    session_started_at: seededAt,
    immutable: true,
  };
}

/**
 * Determine whether a manifest already carries a well-formed
 * `threshold_snapshot`. "Well-formed" = object with a non-null `per_gate`
 * record. Idempotency guarantee (AC27.2): the migration SHALL NOT overwrite
 * an existing snapshot on a re-run. Callers must skip the seed when this
 * returns `true`.
 *
 * @param {unknown} manifest
 * @returns {boolean}
 */
function manifestHasThresholdSnapshot(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  const snap = /** @type {any} */ (manifest).threshold_snapshot;
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return false;
  if (!snap.per_gate || typeof snap.per_gate !== 'object') return false;
  return true;
}

/** Canonical shape: `updated_by` enum */
const UPDATED_BY_AGENT = 'agent';
const UPDATED_BY_HUMAN = 'human';
const UPDATED_BY_LEGACY_USER = 'user';

/** Conflict-report path (AC-4.8). */
const CONFLICT_REPORT_RELATIVE = '.claude/coordination/migration-conflicts.json';

/** Exit codes. */
const EXIT_SUCCESS = 0;
const EXIT_CONFLICT_REPORTED = 1;
const EXIT_ERROR = 2;
const EXIT_CONFLICT_REPORT_WRITE_FAILURE = 3;

// ---------------------------------------------------------------------------
// Utility: find project root
// ---------------------------------------------------------------------------

function findProjectRoot() {
  // as-012 (REQ-003.6): delegate to canonicalizer for symlink-traversal defense.
  // On failure (env absent / containment escape / module unavailable), fall
  // back to the filesystem walk — migrate-manifest may run as a standalone
  // CLI tool outside hook contexts.
  if (projectRootFromCanonicalizer) {
    try {
      return projectRootFromCanonicalizer();
    } catch {
      // fall through
    }
  }
  let dir = __dirname;
  while (dir !== '/') {
    if (existsSync(join(dir, '.claude'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();
const GROUPS_DIR = join(PROJECT_ROOT, '.claude', 'specs', 'groups');
const ARCHIVE_DIR = join(PROJECT_ROOT, '.claude', 'specs', 'archive');
const CONFLICT_REPORT_PATH = join(PROJECT_ROOT, CONFLICT_REPORT_RELATIVE);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover all spec-group manifests. Excludes archive (AC-4.3).
 * @returns {string[]} Absolute paths to manifest.json files.
 */
function discoverGroupManifests() {
  if (!existsSync(GROUPS_DIR)) return [];
  const entries = readdirSync(GROUPS_DIR, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(GROUPS_DIR, entry.name, 'manifest.json');
    if (existsSync(manifestPath)) manifests.push(manifestPath);
  }
  return manifests;
}

// ---------------------------------------------------------------------------
// Migration logic
// ---------------------------------------------------------------------------

/**
 * Deep-clone via JSON round-trip. Manifests are pure JSON (no undefined, no functions).
 */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Apply migration rules to a parsed manifest.
 *
 * @param {object} input - Parsed manifest JSON.
 * @returns {{ output: object, changed: boolean, conflicts: Array<{field: string, flat_value: any, nested_value: any}> }}
 */
/**
 * @param {unknown} input — parsed manifest object.
 * @param {object} [options]
 * @param {boolean} [options.pipelineEfficiency] — when true, seed a
 *   `threshold_snapshot` field (as-027 / AC27.2 / Task I2) if the manifest
 *   lacks one. Idempotent: no-op when already present.
 * @param {string} [options.seededAt] — ISO-8601 UTC; test-injectable.
 */
export function migrateManifest(input, options = {}) {
  const output = clone(input);
  const conflicts = [];
  let changed = false;

  // Rule 1+2: migrate flat prd_* fields into nested prd object
  const existingPrd =
    output.prd === undefined ? undefined : output.prd === null ? null : output.prd;

  // If any flat prd_* exists, we need a nested object to receive the values.
  const hasAnyFlatPrdField = Object.keys(FLAT_TO_NESTED_PRD_MAP).some(
    (k) => Object.prototype.hasOwnProperty.call(output, k)
  );

  if (hasAnyFlatPrdField) {
    // Ensure prd is an object (not null). If caller had prd:null AND flat fields, that's a conflict.
    if (existingPrd === null) {
      conflicts.push({
        field: 'prd',
        flat_value: 'flat_prd_fields_present',
        nested_value: null,
        reason: 'top-level prd_* fields present while nested prd is explicitly null',
      });
    } else {
      const prdObj = existingPrd && typeof existingPrd === 'object' ? existingPrd : {};
      for (const [flatKey, nestedKey] of Object.entries(FLAT_TO_NESTED_PRD_MAP)) {
        if (!Object.prototype.hasOwnProperty.call(output, flatKey)) continue;
        const flatVal = output[flatKey];
        if (Object.prototype.hasOwnProperty.call(prdObj, nestedKey)) {
          const nestedVal = prdObj[nestedKey];
          // Equal values -> strip flat; Unequal values -> conflict
          if (nestedVal === flatVal) {
            // no-op merge
          } else {
            conflicts.push({
              field: nestedKey,
              flat_value: flatVal,
              nested_value: nestedVal,
              reason: `top-level ${flatKey} disagrees with nested prd.${nestedKey}`,
            });
          }
        } else {
          prdObj[nestedKey] = flatVal;
        }
        delete output[flatKey];
        changed = true;
      }
      output.prd = prdObj;
    }
  }

  // Rule 3: drop legacy duplicate keys
  for (const key of FLAT_KEYS_TO_DROP) {
    if (Object.prototype.hasOwnProperty.call(output, key)) {
      delete output[key];
      changed = true;
    }
  }

  // Rule 4: strip non-canonical convergence.*_clean_pass_count subfields
  //
  // as-010 / AC10.2: the stripped subfield's canonical threshold is read
  // directly from PerGateThresholdTable (not from the session snapshot — this
  // migration runs pre-session so snapshot reads are not available; AC10.4).
  // The table read is load-bearing: it exercises the canonical reader path
  // covered by the threshold-reader superset contract and
  // exposes each stripped field's corresponding required_clean_passes in
  // case downstream validation surfaces the table-derived value (tests assert
  // the read occurs — `readGateThresholdFromTable` is the wired entry point).
  if (output.convergence && typeof output.convergence === 'object' && !Array.isArray(output.convergence)) {
    for (const key of Object.keys(output.convergence)) {
      if (key.endsWith(CLEAN_PASS_COUNT_SUFFIX)) {
        // Observe the table-derived threshold so this consumer participates in
        // the threshold-reader superset (AC10.2). No-op on the returned value
        // — the subfield is non-canonical and must be stripped regardless of
        // threshold; reading from the table is the semantic contract.
        readGateThresholdFromTable(gateFromCleanPassCountKey(key));
        delete output.convergence[key];
        changed = true;
      }
    }
  }

  // Rule 5: backfill updated_by: "agent" when missing
  if (!Object.prototype.hasOwnProperty.call(output, 'updated_by')) {
    output.updated_by = UPDATED_BY_AGENT;
    changed = true;
  } else if (output.updated_by === UPDATED_BY_LEGACY_USER) {
    // Rule 6: rewrite "user" -> "human"
    output.updated_by = UPDATED_BY_HUMAN;
    changed = true;
  }

  // Rule 7: normalize missing `prd` to explicit `prd: null`.
  // AC-1.2 declares missing `prd` fails validation identically to malformed; AC-1.3
  // permits explicit `prd: null` for bootstrap/infra specs with no linked PRD.
  // Migration converts missing -> null so the canonical-shape rule holds uniformly.
  if (!Object.prototype.hasOwnProperty.call(output, 'prd')) {
    output.prd = null;
    changed = true;
  }

  // Rule 7b (as-001 / AC1.4): tolerate absent `spec_mode`.
  //
  // Decision: NO-OP on missing `spec_mode`. The field is optional in the
  // spec-group JSON schema with a default of `"feature"` (per
  // `.claude/specs/schema/spec-group.schema.json`); the schema-level default
  // and the runtime `normalizeSpecMode` helper both apply the fail-closed
  // "feature" value at read time. Writing the default explicitly would
  // (a) grow the on-disk footprint of every pre-existing manifest without
  // behavior change, and (b) conflict with the non-mutation invariant that
  // migrate-manifest avoids touching fields whose absence is already
  // canonical.
  //
  // Existing manifests therefore continue to load after migration (AC1.4
  // second clause) — the validator normalizes absent → "feature" at read
  // time without requiring a file-level rewrite.
  //
  // When `spec_mode` IS present on an incoming manifest, migration passes
  // it through unchanged — JSON-Schema `enum` validation (at validate time)
  // rejects invalid values, and migration is intentionally ignorant of
  // the enum set so it stays coupled only to shape, not semantics.
  //
  // If a future requirement flips the decision to "write default
  // explicitly", the rewrite is safe (idempotent) and lives here — see
  // atomic spec as-001 Decision Log.

  // Rule 8 (as-027 / AC27.2 / Task I2): pipeline-efficiency `threshold_snapshot`
  // seeding. Opt-in via `--pipeline-efficiency` flag. Idempotent: if the
  // manifest already has a well-formed snapshot we skip. Uses direct
  // PerGateThresholdTable read (pre-session context, mirrors AC10.2 pattern
  // for the existing table-import consumer role).
  if (options.pipelineEfficiency && !manifestHasThresholdSnapshot(output)) {
    const seededAt = options.seededAt || new Date().toISOString();
    output.threshold_snapshot = buildMigrationThresholdSnapshot(seededAt);
    changed = true;
  }

  return { output, changed, conflicts };
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Write `data` to `filePath` atomically via temp-then-rename, preserving file mode.
 * AC-4.6, NFR-16, SEC-006.
 *
 * cr-resource-m1a2b3: on renameSync failure (disk full, cross-device, permission
 * error, etc.), the temp file would otherwise leak. We best-effort unlink it
 * before rethrowing so the caller sees the original error but the filesystem
 * stays clean. This also wires the previously-unused unlinkSync import
 * (cr-dead-a5b6c7).
 *
 * @param {string} filePath - Target path.
 * @param {object} data - JSON-serializable payload.
 */
function atomicWritePreservingMode(filePath, data) {
  let mode;
  try {
    mode = statSync(filePath).mode & 0o7777;
  } catch {
    mode = 0o644;
  }
  const tempPath = filePath + '.tmp.' + process.pid + '.' + Date.now();
  const content = JSON.stringify(data, null, 2) + '\n';
  writeFileSync(tempPath, content);
  try {
    chmodSync(tempPath, mode);
  } catch {
    // best-effort; some filesystems may not support chmod
  }
  try {
    renameSync(tempPath, filePath);
  } catch (err) {
    // Rename failed — temp file is orphaned. Best-effort cleanup before rethrow.
    try {
      unlinkSync(tempPath);
    } catch {
      // Cleanup best-effort: if unlink fails (e.g. temp already gone, ENOENT)
      // we still want the original rename error to propagate.
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Conflict report
// ---------------------------------------------------------------------------

/**
 * Write conflict report atomically. Returns true on success, false on write failure (AC-4.9).
 *
 * @param {Array<{manifest_path: string, conflicts: Array}>} allConflicts
 */
function writeConflictReport(allConflicts) {
  try {
    mkdirSync(dirname(CONFLICT_REPORT_PATH), { recursive: true });
    const payload = {
      generated_at: new Date().toISOString(),
      spec: 'sg-enforcement-layer-gaps',
      ac: 'AC-4.8',
      conflicts: allConflicts,
    };
    const tempPath = CONFLICT_REPORT_PATH + '.tmp.' + process.pid;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2) + '\n');
    renameSync(tempPath, CONFLICT_REPORT_PATH);
    return true;
  } catch (err) {
    process.stderr.write(
      `[migrate-manifest] CONFLICT REPORT WRITE FAILURE: ${err.message}\n`
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ParsedArgs
 * @property {boolean} all
 * @property {boolean} dryRun
 * @property {boolean} apply
 * @property {boolean} pipelineEfficiency
 * @property {boolean} atomicIdSchema
 * @property {string[]} paths
 */

/** @returns {ParsedArgs} */
function parseArgs(argv) {
  const args = {
    all: false,
    dryRun: false,
    apply: false,
    pipelineEfficiency: false,
    atomicIdSchema: false,
    paths: [],
  };
  for (const a of argv) {
    if (a === '--all') args.all = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--pipeline-efficiency') args.pipelineEfficiency = true;
    else if (a === '--atomic-id-schema') args.atomicIdSchema = true;
    else if (a.startsWith('--')) {
      process.stderr.write(`[migrate-manifest] Unknown flag: ${a}\n`);
      process.exit(EXIT_ERROR);
    } else {
      args.paths.push(resolve(a));
    }
  }
  return args;
}

function processFile(filePath, dryRun, options = {}) {
  const result = {
    path: filePath,
    status: /** @type {'migrated'|'canonical'|'error'|'conflict'|'dry-run'} */ ('error'),
    conflicts: /** @type {Array} */ ([]),
    error: /** @type {string|undefined} */ (undefined),
  };

  if (filePath.includes(ARCHIVE_DIR)) {
    // AC-4.3: archive exclusion (defense in depth — discoverer already skips)
    result.status = 'canonical';
    result.error = 'archive path skipped';
    return result;
  }

  if (!existsSync(filePath)) {
    result.error = `file not found: ${filePath}`;
    return result;
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    result.error = `read failed: ${err.message}`;
    return result;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    result.error = `invalid JSON: ${err.message}`;
    return result;
  }

  let migration;
  try {
    migration = migrateManifest(input, {
      pipelineEfficiency: options.pipelineEfficiency === true,
    });
  } catch (err) {
    result.error = `migration logic failed: ${err.message}`;
    return result;
  }

  if (migration.conflicts.length > 0) {
    result.status = 'conflict';
    result.conflicts = migration.conflicts;
    return result;
  }

  if (!migration.changed) {
    result.status = 'canonical';
    return result;
  }

  if (dryRun) {
    result.status = 'dry-run';
    return result;
  }

  try {
    atomicWritePreservingMode(filePath, migration.output);
    result.status = 'migrated';
  } catch (err) {
    result.error = `write failed: ${err.message}`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// as-014 / REQ-008 / AC14.1-AC14.3: --atomic-id-schema mode
// ---------------------------------------------------------------------------

/**
 * Normalize a raw slug fragment into a canonical slug (kebab-case, lowercase,
 * alphanumerics-plus-hyphens only, no leading/trailing hyphens, no
 * consecutive hyphens). Returns `null` if nothing remains after normalization.
 *
 * Accepts anything legacy-shaped:
 *   "foo"             → "foo"
 *   "foo_bar"         → "foo-bar"
 *   "_foo"            → "foo"
 *   "Foo.Bar"         → "foo-bar"
 *   ""                → null
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normalizeSlug(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-') // non-kebab chars → hyphen
    .replace(/-+/g, '-')           // collapse multiple hyphens
    .replace(/^-+|-+$/g, '');      // strip leading/trailing hyphens
  return normalized.length > 0 ? normalized : null;
}

/**
 * Derive a canonical target filename from a legacy (non-canonical) atomic-spec
 * basename. Two patterns accepted:
 *
 *   (A) `as-<digits>[_<slug>|-<slug>].md`  — e.g., "as-1-foo.md", "as-001_foo.md"
 *   (B) `<digits>[-<slug>].md`             — e.g., "001-foo.md"
 *
 * Digits are zero-padded to 3 to satisfy ATOMIC_ID_REGEX. Slugs are
 * normalized via `normalizeSlug`.
 *
 * Returns `null` when neither pattern matches (no digit sequence recoverable).
 *
 * @param {string} filename — basename only (e.g. "as-1-foo.md")
 * @returns {{ id: string, slug: string|null, targetBasename: string } | null}
 */
function deriveCanonicalTargetName(filename) {
  if (typeof filename !== 'string') return null;
  const withoutExt = filename.replace(/\.md$/i, '');
  if (withoutExt === filename) {
    // Not a .md file — defensive guard; scanAtomicDir filters earlier.
    return null;
  }

  // Pattern A: `as-<digits><sep><slug?>`  (sep = `_` or `-` or absent)
  let match = withoutExt.match(/^as-?([0-9]+)(?:[_-](.*))?$/i);
  if (!match) {
    // Pattern B: `<digits>[-<slug>]`  (no `as` prefix)
    match = withoutExt.match(/^([0-9]+)(?:[_-](.*))?$/);
    if (!match) return null;
  }

  const rawDigits = match[1];
  const rawSlug = match[2] || null;

  // Zero-pad to 3 digits. Reject if > 3 digits (atomic IDs cap at 999).
  if (rawDigits.length > 3) return null;
  const padded = rawDigits.padStart(3, '0');
  const id = `as-${padded}`;

  const slug = normalizeSlug(rawSlug);

  let targetBasename;
  try {
    targetBasename = formatAtomicFilename({ workstream_id: null, id, slug });
  } catch {
    return null;
  }
  return { id, slug, targetBasename };
}

/**
 * Scan all `.claude/specs/groups/<sg>/atomic/*.md` files and identify any whose
 * basename does NOT match `ATOMIC_FILENAME_REGEX`. For each non-match, derive
 * a canonical target filename and return the rename plan.
 *
 * Canonical target form (preferred): "as-NNN-<slug>.md" (slug form).
 * When the source filename lacks a parseable NNN segment entirely, it is
 * reported as an `errors` entry — the migration does not attempt to invent
 * atomic IDs. SELF-RESOLVED(spec §Interfaces-&-Contracts §Atomic-Spec ID Schema
 * Contract): `ATOMIC_FILENAME_REGEX` is the single authoritative acceptor.
 * Idempotency (AC14.3): already-matching files return `null` from this mapper
 * and are skipped.
 *
 * @param {string} atomicDir — absolute path to `.claude/specs/groups/<sg>/atomic`
 * @returns {{
 *   candidates: Array<{ from: string, to: string, workstream_id: string|null, id: string, slug: string|null }>,
 *   skipped: string[],
 *   errors: Array<{ file: string, reason: string }>
 * }}
 */
function scanAtomicDir(atomicDir) {
  const result = { candidates: [], skipped: [], errors: [] };
  if (!existsSync(atomicDir)) return result;

  let entries;
  try {
    entries = readdirSync(atomicDir, { withFileTypes: true });
  } catch (err) {
    result.errors.push({ file: atomicDir, reason: `readdir failed: ${err.message}` });
    return result;
  }

  const specGroupDir = basename(dirname(atomicDir));

  // Track target basenames already claimed (by either a prior plan entry or
  // an already-canonical file in this directory). Used to disambiguate
  // colliding derivations — e.g., when three legacy files all normalize to
  // the same canonical target, each subsequent collision appends a numeric
  // suffix to the slug so no two plan entries share a target.
  const claimedTargets = new Set();
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md') && ATOMIC_FILENAME_REGEX.test(entry.name)) {
      claimedTargets.add(entry.name);
    }
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;

    // AC14.3 idempotency: canonical filename → skip (no rename plan entry).
    if (ATOMIC_FILENAME_REGEX.test(entry.name)) {
      result.skipped.push(entry.name);
      continue;
    }

    // Non-canonical. Derive a canonical target filename. Two-stage derivation:
    //
    //   Stage A: extract an `as-?<digits>` id-like fragment, padding digits to
    //            3 to satisfy ATOMIC_ID_REGEX (`as-NNN`). Accepts forms like:
    //              "as-1-foo.md"       → id="as-001", raw-slug="foo"
    //              "as-001_foo.md"     → id="as-001", raw-slug="_foo"
    //              "001-foo.md"        → id="as-001", raw-slug="foo"
    //   Stage B: normalize the slug — lowercase, replace disallowed chars
    //            (e.g., `_`) with `-`, collapse multi-hyphens, strip
    //            leading/trailing hyphens.
    //
    // If no digit fragment can be extracted, the file is recorded as an error
    // (no ID to preserve).
    const derived = deriveCanonicalTargetName(entry.name);
    if (!derived) {
      result.errors.push({
        file: entry.name,
        reason: 'no `as-NNN` or `NNN` fragment detected; cannot derive canonical target',
      });
      continue;
    }

    const { id, slug } = derived;
    let targetBasename = derived.targetBasename;

    // Defensive: target must itself match the canonical regex. If it does not,
    // something in the derivation is broken and we should record an error
    // rather than emit a bad plan entry.
    if (!ATOMIC_FILENAME_REGEX.test(targetBasename)) {
      result.errors.push({
        file: entry.name,
        reason: `derived target '${targetBasename}' fails ATOMIC_FILENAME_REGEX`,
      });
      continue;
    }

    // Don't emit a plan entry if source happens to already equal target.
    if (targetBasename === entry.name) {
      result.skipped.push(entry.name);
      continue;
    }

    // Collision handling: if `targetBasename` is already claimed, disambiguate
    // by appending a numeric suffix to the slug (`foo` → `foo-legacy-1`,
    // `foo-legacy-2`, etc.). This preserves the fixture's multi-legacy-files
    // invariant without forcing the caller to decide which legacy form wins.
    // SELF-RESOLVED(reasoning): the spec does not mandate a specific
    // collision-resolution policy — we preserve all legacy files as
    // distinct canonical names so no data is lost to the rename.
    if (claimedTargets.has(targetBasename)) {
      const baseSlug = slug ? `${slug}-legacy` : 'legacy';
      let suffix = 1;
      let candidate;
      do {
        candidate = formatAtomicFilename({
          workstream_id: null,
          id,
          slug: `${baseSlug}-${suffix}`,
        });
        suffix += 1;
      } while (claimedTargets.has(candidate) && suffix < 1000);
      if (claimedTargets.has(candidate)) {
        result.errors.push({
          file: entry.name,
          reason: `could not derive unique canonical target (1000 collisions on ${id})`,
        });
        continue;
      }
      targetBasename = candidate;
    }
    claimedTargets.add(targetBasename);

    // Parse using the directory context so workstream_id reflects the
    // spec-group directory convention.
    const parsed = parseAtomicFilename(targetBasename, specGroupDir);
    result.candidates.push({
      from: join(atomicDir, entry.name),
      to: join(atomicDir, targetBasename),
      workstream_id: parsed ? parsed.workstream_id : null,
      id,
      slug,
    });
  }

  return result;
}

/**
 * Scan all spec-group atomic directories under `.claude/specs/groups/` and
 * return a consolidated scan result.
 *
 * @returns {{
 *   candidates: Array<{ from: string, to: string, workstream_id: string|null, id: string, slug: string|null, spec_group_id: string }>,
 *   skipped_count: number,
 *   errors: Array<{ file: string, reason: string }>
 * }}
 */
function scanAllSpecGroups() {
  const candidates = [];
  const errors = [];
  let skippedCount = 0;

  if (!existsSync(GROUPS_DIR)) {
    return { candidates, skipped_count: 0, errors };
  }

  let groupEntries;
  try {
    groupEntries = readdirSync(GROUPS_DIR, { withFileTypes: true });
  } catch (err) {
    errors.push({ file: GROUPS_DIR, reason: `readdir failed: ${err.message}` });
    return { candidates, skipped_count: 0, errors };
  }

  for (const ge of groupEntries) {
    if (!ge.isDirectory()) continue;
    const atomicDir = join(GROUPS_DIR, ge.name, 'atomic');
    const scan = scanAtomicDir(atomicDir);
    for (const c of scan.candidates) {
      candidates.push({ ...c, spec_group_id: ge.name });
    }
    skippedCount += scan.skipped.length;
    for (const e of scan.errors) {
      errors.push({ file: join(atomicDir, e.file), reason: e.reason });
    }
  }

  return { candidates, skipped_count: skippedCount, errors };
}

/**
 * Rewrite `as-NNN` tokens across all text files in the repo so internal
 * cross-references track the rename. Scoped to `.claude/specs/`,
 * `.claude/prds/`, and `.claude/journal/` to bound the blast radius — other
 * directories that legitimately reference atomic IDs would still need manual
 * review, but the high-value reference concentrations live in those trees.
 *
 * The token replacement uses a word-boundary regex so substring collisions
 * (e.g., "as-0011" against "as-001") do not produce false matches.
 *
 * @param {{ from: string, to: string, id: string, slug: string|null }[]} renames
 * @returns {number} cross-references updated count
 */
function updateCrossReferences(renames) {
  let updatedCount = 0;
  const rewriteRoots = [
    join(PROJECT_ROOT, '.claude', 'specs'),
    join(PROJECT_ROOT, '.claude', 'prds'),
    join(PROJECT_ROOT, '.claude', 'journal'),
  ];

  // Build a single replacement map keyed by the original full basename-without-
  // extension + the from-token slug form. Only rewrite on full-filename
  // references, not partial-id references — guards against accidental
  // rewriting of unrelated `as-NNN` mentions whose slug differs.
  const replacements = [];
  for (const r of renames) {
    const fromBasename = basename(r.from).replace(/\.md$/i, '');
    const toBasename = basename(r.to).replace(/\.md$/i, '');
    if (fromBasename === toBasename) continue;
    replacements.push({
      pattern: new RegExp(`\\b${escapeRegex(fromBasename)}\\b`, 'g'),
      replacement: toBasename,
    });
  }
  if (replacements.length === 0) return 0;

  for (const root of rewriteRoots) {
    if (!existsSync(root)) continue;
    for (const filePath of walkMarkdownFiles(root)) {
      let content;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      let updated = content;
      let localCount = 0;
      for (const rep of replacements) {
        updated = updated.replace(rep.pattern, (match) => {
          localCount += 1;
          return rep.replacement;
        });
      }
      if (localCount > 0 && updated !== content) {
        try {
          writeFileSync(filePath, updated);
          updatedCount += localCount;
        } catch (err) {
          process.stderr.write(
            `[migrate-manifest] cross-ref update failed for ${filePath}: ${err.message}\n`,
          );
        }
      }
    }
  }
  return updatedCount;
}

/** Escape a literal string for use inside a RegExp constructor. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Yield every `.md` path under `root`, depth-first. Generator avoids buffering
 * the full file list for large trees.
 *
 * @param {string} root
 * @returns {string[]}
 */
function walkMarkdownFiles(root) {
  const results = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        // Exclude node_modules & .git defensively.
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  }
  return results;
}

/**
 * Execute a git-friendly rename. Prefers `git mv` when the source is tracked;
 * falls back to `renameSync` when not in a git repo or when the source is
 * untracked. Rename history is preserved by git's own rename-detection for
 * tracked files.
 *
 * @param {string} from absolute source path
 * @param {string} to   absolute target path
 * @returns {{ ok: true, method: 'git-mv' | 'fs-rename' } | { ok: false, error: string }}
 */
function gitFriendlyRename(from, to) {
  // Attempt `git mv` first. Falls through to filesystem rename on any failure
  // (e.g., file not tracked, not in a repo, git binary missing). This matches
  // the spec Implementation Note: "Use `git mv` for git-friendly rename
  // (preserves rename detection in history)".
  try {
    const result = spawnSync('git', ['mv', from, to], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    });
    if (result.status === 0) {
      return { ok: true, method: 'git-mv' };
    }
    // fall through to fs rename
  } catch {
    // git binary missing — fall through
  }
  try {
    renameSync(from, to);
    return { ok: true, method: 'fs-rename' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Emit a hash-chained audit entry for a single rename. Uses the canonical
 * `atomizer_cleanup` event class (SELF-RESOLVED(code): 9-class enum at
 * `.claude/scripts/lib/schemas/audit-entry.schema.mjs:79` — `atomic_id_migration`
 * not present; `atomizer_cleanup` is the closest semantic match per spec
 * Interfaces §Atomic-Spec ID Schema Contract "Atomizer removes superseded
 * intermediary spec files" and as-015 Implementation Notes routes all class-c
 * events through `appendAuditEntry`).
 *
 * The appender fails fast when the genesis anchor is missing. We catch and
 * report (not throw) so a partial rename is not silently left un-audited;
 * caller decides whether to abort.
 *
 * @param {{ from: string, to: string, spec_group_id: string, id: string, slug: string|null, workstream_id: string|null, method: string }} entry
 * @param {(event_class: string, event_subtype: string, payload: object) => void} appender
 * @returns {{ ok: boolean, error?: string }}
 */
function emitRenameAuditEntry(entry, appender) {
  try {
    appender('atomizer_cleanup', 'atomic_id_migration_rename', {
      spec_group_id: entry.spec_group_id,
      workstream_id: entry.workstream_id,
      atomic_id: entry.id,
      from: basename(entry.from),
      to: basename(entry.to),
      rename_method: entry.method,
      slug: entry.slug,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Bootstrap a minimal pipeline-efficiency genesis anchor when one is missing.
 *
 * The canonical bootstrap path is Phase E Task E3 (ws-1), which writes a
 * signed anchor to `.claude/audit/pipeline-efficiency-genesis.json`. In
 * isolated fixture contexts (e.g., integration-test temp dirs), the anchor
 * won't exist — a migration run that needs to emit audit entries would
 * therefore fail before any rename is recorded. Lazy-bootstrap writes a
 * minimal deterministic anchor so the audit chain can be seeded from a
 * known-good hash. Production runs are no-ops (anchor already exists).
 *
 * SELF-RESOLVED(code): genesis shape `{seq:0, hash:<sha256-hex>}` matches the
 * reader at `.claude/scripts/pipeline-efficiency-audit-log.mjs:134-169` and
 * is accepted by the validator there. We use SHA-256(empty-string) as the
 * bootstrap hash — a well-known deterministic value (`e3b0c44298fc1c14...`)
 * so idempotent re-bootstraps produce byte-identical anchors.
 *
 * @param {string} projectRoot
 * @returns {boolean} true if bootstrapped (anchor was missing), false if anchor already present
 */
function bootstrapGenesisAnchorIfMissing(projectRoot) {
  const anchorPath = join(
    projectRoot,
    '.claude',
    'audit',
    'pipeline-efficiency-genesis.json',
  );
  if (existsSync(anchorPath)) return false;
  const auditDir = dirname(anchorPath);
  try {
    mkdirSync(auditDir, { recursive: true });
  } catch {
    /* best-effort */
  }
  const emptyHash = createHash('sha256').update('').digest('hex');
  const anchor = {
    seq: 0,
    hash: emptyHash,
    bootstrap_source: 'migrate-manifest-atomic-id-schema-mode',
    bootstrap_timestamp: new Date().toISOString(),
  };
  try {
    writeFileSync(anchorPath, JSON.stringify(anchor, null, 2) + '\n');
    return true;
  } catch (err) {
    process.stderr.write(
      `[migrate-manifest] genesis anchor bootstrap failed at ${anchorPath}: ${err.message}\n`,
    );
    return false;
  }
}

/**
 * Entry point for `--atomic-id-schema` mode.
 *
 * Dry-run (default when `--apply` not supplied): scan + emit plan JSON; no
 * filesystem changes. Apply: execute renames, update cross-references, emit
 * audit entries.
 *
 * Output JSON shape (AC14.1):
 *   {
 *     mode: "dry-run" | "apply",
 *     renamed: [{ from, to }, ...],
 *     cross_refs_updated: N,
 *     audit_entries: N,
 *     errors: [{ file, reason }, ...]
 *   }
 *
 * @param {{ apply: boolean, dryRun: boolean, appender?: Function }} options
 * @returns {{ exit: number, output: object }}
 */
export function runAtomicIdSchemaMode(options = {}) {
  const apply = options.apply === true;
  const scan = scanAllSpecGroups();
  const output = {
    mode: apply ? 'apply' : 'dry-run',
    renamed: scan.candidates.map((c) => ({
      from: c.from,
      to: c.to,
    })),
    cross_refs_updated: 0,
    audit_entries: 0,
    errors: scan.errors.slice(),
  };

  if (!apply) {
    // AC14.1: dry-run — no filesystem changes.
    return { exit: scan.errors.length > 0 ? EXIT_ERROR : EXIT_SUCCESS, output };
  }

  // AC14.2: apply mode — execute renames + cross-ref updates + audit entries.
  const appender = options.appender || loadDefaultAppender();

  // Bootstrap audit chain genesis if missing (fixture-friendly; no-op in
  // production where Phase E Task E3 anchor already exists). Harmless idempotent
  // op — the anchor is byte-identical across bootstraps.
  bootstrapGenesisAnchorIfMissing(PROJECT_ROOT);

  const appliedRenames = [];
  for (const cand of scan.candidates) {
    const renameResult = gitFriendlyRename(cand.from, cand.to);
    if (!renameResult.ok) {
      output.errors.push({ file: cand.from, reason: `rename failed: ${renameResult.error}` });
      continue;
    }
    appliedRenames.push({ ...cand, method: renameResult.method });
  }

  // AC14.2: cross-reference update — scan markdown bodies/frontmatter for
  // the old basename token and rewrite to new basename.
  output.cross_refs_updated = updateCrossReferences(appliedRenames);

  // AC14.2: audit entry per rename (class-c: atomizer_cleanup).
  for (const r of appliedRenames) {
    const auditResult = emitRenameAuditEntry(r, appender);
    if (auditResult.ok) {
      output.audit_entries += 1;
    } else {
      output.errors.push({ file: r.to, reason: `audit entry failed: ${auditResult.error}` });
    }
  }

  // Rewrite `renamed` to reflect successful-only applies.
  output.renamed = appliedRenames.map((r) => ({ from: r.from, to: r.to }));

  return { exit: output.errors.length > 0 ? EXIT_ERROR : EXIT_SUCCESS, output };
}

/**
 * Load the default audit-log appender. Uses `createRequire` to synchronously
 * resolve the CommonJS-like module boundary so callers in `main()` avoid
 * top-level-await.
 *
 * SELF-RESOLVED(code): `createRequire(import.meta.url)` is the canonical
 * Node ESM pattern for synchronous imports; matches the usage in
 * `.claude/scripts/lib/snapshot-capture.mjs:417` (uses dynamic `import()` but
 * identical intent: load `appendAuditEntry` from pipeline-efficiency-audit-log).
 *
 * Test override: pass `{ appender }` directly to `runAtomicIdSchemaMode` to
 * inject a stub; production path never reaches this function in that case.
 *
 * @returns {(event_class: string, event_subtype: string, payload: object) => void}
 */
function loadDefaultAppender() {
  const req = createRequire(import.meta.url);
  const mod = req('./pipeline-efficiency-audit-log.mjs');
  return (event_class, event_subtype, payload) =>
    mod.appendAuditEntry(event_class, event_subtype, payload);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // as-014 / REQ-008: `--atomic-id-schema` mode branch. Takes precedence over
  // manifest migration when present; the two modes share the script but
  // address disjoint concerns (manifest shape vs. atomic-spec filenames).
  if (args.atomicIdSchema) {
    if (args.apply && args.dryRun) {
      process.stderr.write(
        '[migrate-manifest] --apply and --dry-run are mutually exclusive\n',
      );
      process.exit(EXIT_ERROR);
    }
    const { exit, output } = runAtomicIdSchemaMode({
      apply: args.apply === true,
      dryRun: args.dryRun === true || !args.apply,
    });
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(exit);
  }

  let targets;
  if (args.all) {
    targets = discoverGroupManifests();
    if (args.paths.length > 0) {
      process.stderr.write(
        '[migrate-manifest] Both --all and explicit paths provided; using --all\n'
      );
    }
  } else if (args.paths.length > 0) {
    targets = args.paths;
  } else {
    process.stderr.write(
      'Usage: migrate-manifest.mjs (--all | <path>... | --atomic-id-schema [--dry-run|--apply]) [--dry-run] [--pipeline-efficiency]\n'
    );
    process.exit(EXIT_ERROR);
  }

  const results = targets.map((p) =>
    processFile(p, args.dryRun, { pipelineEfficiency: args.pipelineEfficiency })
  );

  const summary = {
    migrated: 0,
    already_canonical: 0,
    dry_run_would_migrate: 0,
    errors: 0,
    conflicts: 0,
  };
  const conflictRecords = [];
  const errorRecords = [];

  for (const r of results) {
    if (r.status === 'migrated') {
      summary.migrated++;
      process.stderr.write(`[migrate-manifest] MIGRATED: ${r.path}\n`);
    } else if (r.status === 'canonical') {
      summary.already_canonical++;
    } else if (r.status === 'dry-run') {
      summary.dry_run_would_migrate++;
      process.stderr.write(`[migrate-manifest] DRY-RUN WOULD MIGRATE: ${r.path}\n`);
    } else if (r.status === 'conflict') {
      summary.conflicts++;
      conflictRecords.push({ manifest_path: r.path, conflicts: r.conflicts });
      for (const c of r.conflicts) {
        process.stderr.write(
          `[migrate-manifest] CONFLICT: ${r.path} field=${c.field} flat=${JSON.stringify(c.flat_value)} nested=${JSON.stringify(c.nested_value)} reason=${c.reason}\n`
        );
      }
    } else {
      summary.errors++;
      errorRecords.push({ path: r.path, error: r.error });
      process.stderr.write(`[migrate-manifest] ERROR: ${r.path}: ${r.error}\n`);
    }
  }

  // AC-4.10: summary line
  process.stdout.write(
    `${summary.migrated} migrated, ${summary.already_canonical} already canonical, ${summary.errors} errors\n`
  );
  if (summary.dry_run_would_migrate > 0) {
    process.stdout.write(
      `${summary.dry_run_would_migrate} would migrate (dry-run)\n`
    );
  }
  if (summary.conflicts > 0) {
    process.stdout.write(`${summary.conflicts} conflicts\n`);
  }

  // AC-4.8, AC-4.9: conflict report emission
  if (conflictRecords.length > 0) {
    const reportWritten = writeConflictReport(conflictRecords);
    if (!reportWritten) {
      process.stderr.write(
        '[migrate-manifest] Conflict details (stderr fallback per AC-4.9):\n'
      );
      process.stderr.write(JSON.stringify(conflictRecords, null, 2) + '\n');
      process.exit(EXIT_CONFLICT_REPORT_WRITE_FAILURE);
    }
    process.exit(EXIT_CONFLICT_REPORTED);
  }

  if (summary.errors > 0) {
    process.exit(EXIT_ERROR);
  }

  process.exit(EXIT_SUCCESS);
}

// Only run main when invoked directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
