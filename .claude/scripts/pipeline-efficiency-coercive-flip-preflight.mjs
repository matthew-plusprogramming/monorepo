#!/usr/bin/env node

/**
 * pipeline-efficiency-coercive-flip-preflight.mjs
 *
 * 3-workstream coercive-flip preflight: atomic reads of kill-switch sentinel,
 * enforcement-flag, and audit-log HEAD; 3-way canonical-baseline presence
 * check; fstat-consistent atomic reads (AC17.6) on each baseline;
 * structured error emission + audit-log on every rejection.
 *
 * Every rejected flip is audit-logged with event_class `flag_flip` and
 * payload `rejected: true` so the hash-chain captures the rejection intent
 * even when no enforcement-state changes (REQ-013 preflight_ordering).
 *
 * Implements: REQ-013, REQ-017, EC-3, EC-9
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning (Phase F — Task F1, F5)
 * Atomic spec: as-020-coercive-flip-preflight
 *
 * Contract: spec.md §Flow 3; §contract-enforcement-primitives.preflight_ordering
 *
 * Dependencies (prerequisites landed):
 *   - as-015: getCurrentMode / getSourceLabel from
 *             pipeline-efficiency-enforcement-reader.mjs
 *   - as-017: appendAuditEntry / readAuditLogHead from
 *             pipeline-efficiency-audit-log.mjs
 *   - as-004: baselineSchema / isSufficientBaseline from
 *             lib/schemas/baseline.schema.mjs
 *   - as-016: kill-switch sentinel basename registered in FULL_BLOCK list
 *             (workflow-file-protection.mjs)
 *
 * CLI exit codes (Task F5 integration surface — completion-verifier consumer):
 *   0  — ACCEPTED (sentinel absent, all 3 baselines present + schema-valid
 *        + sample-size sufficient, audit-log HEAD readable)
 *   2  — REJECTED (any structured failure: SENTINEL_ACTIVE,
 *        BASELINES_INCOMPLETE, BASELINE_SCHEMA_INVALID, BASELINE_INSUFFICIENT,
 *        BASELINE_RACE_ABORT, AUDIT_LOG_HEAD_UNREADABLE,
 *        ENFORCEMENT_FLAG_INVALID, AUDIT_APPEND_FAILED)
 *   1  — UNEXPECTED_ERROR (unanticipated runtime failure — crash-safe path
 *        outside the structured-rejection surface)
 *
 * Programmatic callers:
 *   import { runPreflight } from './pipeline-efficiency-coercive-flip-preflight.mjs';
 *   const result = runPreflight({ projectRoot });
 *   // result: { accepted: boolean, code: string, details: object }
 *
 * Substrate-detection probe (AC20.5) warns non-blocking on mismatch; emitted
 * to stderr only, never gates acceptance.
 */

import {
  existsSync,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCanonicalProjectDir,
  CanonicalProjectDirError,
} from './lib/hook-utils.mjs';
import {
  getCurrentMode,
  getSourceLabel,
  EnforcementConfigInvalidError,
} from './pipeline-efficiency-enforcement-reader.mjs';
import {
  appendAuditEntry,
  readAuditLogHead,
  AuditLogError,
} from './pipeline-efficiency-audit-log.mjs';
import {
  baselineSchema,
  isSufficientBaseline,
} from './lib/schemas/baseline.schema.mjs';

// =============================================================================
// Constants — canonical paths (REQ-017 / spec.md §Baselines)
// =============================================================================

/**
 * Kill-switch sentinel canonical path (relative to project root).
 *
 * Authoritative source: `workflow-file-protection.mjs` FULL_BLOCK basename
 * list — this path is the only location the operator/agent hierarchy
 * recognizes for the pipeline-efficiency kill-switch (NFR-14, EC-3).
 *
 * Presence of this file (regardless of content) SHALL reject any advisory→
 * coercive flip attempt.
 */
const KILL_SWITCH_SENTINEL_RELATIVE = '.claude/coordination/pipeline-efficiency-disabled';

/**
 * Canonical per-workstream baseline paths (REQ-017 / inv-contract-d7b91f).
 *
 * Hard-coded, NOT pattern-expanded (AC20.6). Any variant outside this list
 * SHALL be ignored by the preflight. Order is stable so `missing_baselines`
 * diagnostic output remains deterministic.
 */
const CANONICAL_BASELINE_RELATIVE_PATHS = Object.freeze([
  { ws_id: 'ws-1', relative: '.claude/metrics/pipeline-efficiency-ws1-baseline.json' },
  { ws_id: 'ws-2', relative: '.claude/metrics/pipeline-efficiency-ws2-baseline.json' },
  { ws_id: 'ws-3', relative: '.claude/metrics/pipeline-efficiency-ws3-baseline.json' },
]);

/**
 * Canonical per-workstream scoped-override paths for the UNDERSIZED-baseline
 * branch (AC10.3 / AC10.4). Presence of an override file at the ws-specific
 * canonical path unblocks ONLY that workstream's `BASELINE_INSUFFICIENT`
 * finding — it does NOT unblock ABSENT or SCHEMA_INVALID baselines, and does
 * NOT propagate across workstreams (AC10.4 scope containment).
 *
 * Filename convention embeds the full spec-group id per AC10.4 so a
 * wrong-scope override at a different path cannot leak into this ws.
 *
 * ws-1 and ws-3 have no scoped-override paths assigned in this release; their
 * insufficient findings are not overridable here.
 */
const CANONICAL_BASELINE_OVERRIDE_RELATIVE_PATHS = Object.freeze({
  'ws-2': '.claude/metrics/sg-pipeline-efficiency-ws2-practice-2.4-baseline-override.json',
});

// =============================================================================
// Constants — AC17.6 fstat-consistent atomic-read parameters
// =============================================================================

/**
 * Size-stability probe delay (AC17.6). Two fstatSync calls separated by this
 * interval must report an identical size before the contents are read. If
 * size changes across the probe, the read retries up to
 * BASELINE_RACE_MAX_RETRIES times.
 */
const BASELINE_RACE_PROBE_DELAY_MS = 10;

/** Retry ceiling before `BASELINE_RACE_ABORT` (AC17.6). */
const BASELINE_RACE_MAX_RETRIES = 3;

// =============================================================================
// Constants — CLI exit codes
// =============================================================================

const EXIT_ACCEPTED = 0;
const EXIT_UNEXPECTED = 1;
const EXIT_REJECTED = 2;

// =============================================================================
// Structured-error codes (stderr surface + audit payload)
// =============================================================================

export const PREFLIGHT_ERROR_CODES = Object.freeze({
  SENTINEL_ACTIVE: 'SENTINEL_ACTIVE',
  BASELINES_INCOMPLETE: 'BASELINES_INCOMPLETE',
  BASELINE_SCHEMA_INVALID: 'BASELINE_SCHEMA_INVALID',
  BASELINE_INSUFFICIENT: 'BASELINE_INSUFFICIENT',
  BASELINE_RACE_ABORT: 'BASELINE_RACE_ABORT',
  AUDIT_LOG_HEAD_UNREADABLE: 'AUDIT_LOG_HEAD_UNREADABLE',
  ENFORCEMENT_FLAG_INVALID: 'ENFORCEMENT_FLAG_INVALID',
  AUDIT_APPEND_FAILED: 'AUDIT_APPEND_FAILED',
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Blocking millisecond sleep used by the AC17.6 size-stability probe. Uses
 * Atomics.wait on a zero-length SharedArrayBuffer to avoid a CPU-busy loop
 * (same pattern as lib/hook-utils.mjs:syncSleep — not re-exported there, so
 * we inline the 4-line helper rather than reach into private internals).
 *
 * @param {number} ms
 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Resolve the project root with the same fallback semantics as
 * `pipeline-efficiency-enforcement-reader.mjs`: prefer the canonical
 * (realpath + repo-root-containment) dir; fall back to cwd on
 * CanonicalProjectDirError.
 *
 * @param {{ projectRoot?: string }} [opts]
 * @returns {string}
 */
function resolveProjectRoot(opts = {}) {
  if (opts.projectRoot && typeof opts.projectRoot === 'string') {
    return opts.projectRoot;
  }
  try {
    return getCanonicalProjectDir();
  } catch (err) {
    if (!(err instanceof CanonicalProjectDirError)) throw err;
    return process.cwd();
  }
}

/**
 * Atomic-read a single baseline file with AC17.6 fstat-stability semantics.
 *
 * Behavior:
 *   - Open the file read-only.
 *   - fstatSync → capture size A.
 *   - Sleep BASELINE_RACE_PROBE_DELAY_MS.
 *   - fstatSync → capture size B.
 *   - If A === B: readFileSync (utf-8), close, return parsed JSON.
 *   - If A !== B: close, retry up to BASELINE_RACE_MAX_RETRIES.
 *   - On retry exhaustion: throw `{kind: 'race_abort'}` → surfaces as
 *     `BASELINE_RACE_ABORT`.
 *
 * ENOENT is surfaced distinctly (`{kind: 'missing'}`) so the outer baseline
 * loop can accumulate a `missing_baselines` diagnostic instead of aborting.
 * Any other IO error surfaces as `{kind: 'io', cause}`.
 *
 * @param {string} absolutePath
 * @returns {unknown} parsed JSON (schema not yet validated)
 * @throws {{ kind: 'missing' | 'race_abort' | 'io' | 'parse', cause?: Error, retries?: number }}
 */
function atomicReadBaseline(absolutePath) {
  // Quick early-out: presence check keeps the `{kind:'missing'}` diagnostic
  // cheap (no open+fstat dance) for the hot path where a baseline simply
  // hasn't been published yet (EC-9).
  if (!existsSync(absolutePath)) {
    // eslint-disable-next-line no-throw-literal
    throw { kind: 'missing' };
  }

  let lastSizeA = -1;
  let lastSizeB = -1;
  for (let attempt = 1; attempt <= BASELINE_RACE_MAX_RETRIES; attempt++) {
    let fd;
    try {
      fd = openSync(absolutePath, 'r');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // eslint-disable-next-line no-throw-literal
        throw { kind: 'missing' };
      }
      // eslint-disable-next-line no-throw-literal
      throw { kind: 'io', cause: err };
    }
    try {
      const statA = fstatSync(fd);
      sleepMs(BASELINE_RACE_PROBE_DELAY_MS);
      const statB = fstatSync(fd);
      lastSizeA = statA.size;
      lastSizeB = statB.size;

      if (statA.size !== statB.size) {
        // Size drifted across probe — baseline is mid-write. Close + retry.
        continue;
      }

      // Stable size → read contents. `readFileSync(fd)` reads from current
      // offset; fd was just freshly opened (offset 0) so this captures the
      // whole file consistent with the stable fstat.
      const raw = readFileSync(fd, 'utf-8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // eslint-disable-next-line no-throw-literal
        throw { kind: 'parse', cause: err };
      }
      return parsed;
    } finally {
      try {
        closeSync(fd);
      } catch (closeErr) {
        // cr-silent-m4: read already consumed so close failure cannot
        // corrupt the parsed baseline payload. Emit a structured warning
        // (rather than silent swallow) so fd-leak / NFS-handle anomalies
        // surface to operator observability. Non-fatal: we keep the
        // successful parse result intact for the caller.
        console.warn(
          JSON.stringify({
            level: 'warn',
            source: 'pipeline-efficiency-coercive-flip-preflight',
            reason: 'close_failed_post_fsync',
            error_code: closeErr?.code || null,
            error_message: closeErr?.message || String(closeErr),
            path: absolutePath,
          })
        );
      }
    }
  }

  // AC17.6: retry ceiling exhausted → structured abort.
  // eslint-disable-next-line no-throw-literal
  throw {
    kind: 'race_abort',
    retries: BASELINE_RACE_MAX_RETRIES,
    last_size_a: lastSizeA,
    last_size_b: lastSizeB,
  };
}

/**
 * Substrate-detection probe (AC20.5).
 *
 * Warns non-blocking when the expected baseline substrate (directory
 * containing the 3 canonical files) does not exist. This is a diagnostic
 * signal — the 3-way baseline presence check is still authoritative for
 * accept/reject. Intentionally permissive: the substrate warning fires on
 * directory-level anomalies (e.g., `.claude/metrics/` itself missing) that
 * the per-file ENOENT loop below would otherwise report as three separate
 * `missing_baselines` entries with no accompanying context.
 *
 * @param {string} projectRoot
 * @returns {{ mismatch: boolean, message?: string }}
 */
function substrateProbe(projectRoot) {
  const metricsDir = join(projectRoot, '.claude', 'metrics');
  if (!existsSync(metricsDir)) {
    return {
      mismatch: true,
      message:
        `substrate-probe: .claude/metrics/ directory not present at ${metricsDir}; ` +
        `baselines cannot exist until it is bootstrapped (non-blocking warning).`,
    };
  }
  return { mismatch: false };
}

/**
 * Append a rejection audit entry. Non-throwing: if the append itself fails
 * (e.g., missing genesis anchor during bootstrap tests) we degrade to a
 * secondary structured error `AUDIT_APPEND_FAILED` that callers surface
 * alongside the primary rejection cause — the primary cause is NOT lost.
 *
 * @param {string} projectRoot
 * @param {string} primaryCode   one of PREFLIGHT_ERROR_CODES
 * @param {object} payload       event-specific details
 * @returns {{ appended: boolean, error?: { code: string, message: string } }}
 */
function auditLogRejection(projectRoot, primaryCode, payload) {
  try {
    appendAuditEntry(
      'flag_flip',
      `flip-rejected-${primaryCode.toLowerCase()}`,
      { rejected: true, cause: primaryCode, ...payload },
      { actor: 'agent', projectRoot },
    );
    return { appended: true };
  } catch (err) {
    const code =
      err instanceof AuditLogError
        ? err.code
        : PREFLIGHT_ERROR_CODES.AUDIT_APPEND_FAILED;
    const message = err && err.message ? err.message : String(err);
    return { appended: false, error: { code, message } };
  }
}

/**
 * Append an acceptance audit entry (event_class `flag_flip`,
 * `rejected: false`). Same fail-soft semantics as `auditLogRejection` —
 * acceptance is still signaled via exit code 0 even if the audit append
 * fails, but a non-zero `audit_error` field surfaces the problem to the
 * operator.
 *
 * @param {string} projectRoot
 * @param {object} payload
 * @returns {{ appended: boolean, error?: { code: string, message: string } }}
 */
function auditLogAcceptance(projectRoot, payload) {
  try {
    appendAuditEntry(
      'flag_flip',
      'flip-accepted-advisory-to-coercive',
      { rejected: false, ...payload },
      { actor: 'agent', projectRoot },
    );
    return { appended: true };
  } catch (err) {
    const code =
      err instanceof AuditLogError
        ? err.code
        : PREFLIGHT_ERROR_CODES.AUDIT_APPEND_FAILED;
    const message = err && err.message ? err.message : String(err);
    return { appended: false, error: { code, message } };
  }
}

/**
 * Partition the insufficient-baseline list by scoped-override presence
 * (AC10.3 / AC10.4). For each entry in `insufficient`, if a ws-scoped
 * override file exists at its canonical per-ws path AND is readable as JSON,
 * the entry is moved from `insufficient_remaining` to `insufficient_overridden`.
 *
 * Scope containment (AC10.4): only ws-ids in
 * `CANONICAL_BASELINE_OVERRIDE_RELATIVE_PATHS` have a recognized override
 * path. A file at any other location (different workstream's path, a
 * wrong-scope name) cannot unblock this ws because it is never read.
 *
 * Overridability (AC10.3): only UNDERSIZED baselines are overridable here —
 * this function is called from the `insufficient` branch ONLY. ABSENT
 * (missing) and SCHEMA_INVALID baselines are unchanged by override files per
 * the ws-2 wrapper semantics in `pipeline-efficiency-ws2-coercive-flip-preflight.mjs`.
 *
 * @param {string} projectRoot
 * @param {Array<{ ws_id: string, path: string, sample_count: number }>} insufficient
 * @returns {{
 *   insufficient_remaining: Array<{ ws_id: string, path: string, sample_count: number }>,
 *   insufficient_overridden: Array<{ ws_id: string, path: string, sample_count: number, override_path: string }>,
 * }}
 */
function partitionInsufficientByOverride(projectRoot, insufficient) {
  const remaining = [];
  const overridden = [];
  for (const entry of insufficient) {
    const overrideRel = CANONICAL_BASELINE_OVERRIDE_RELATIVE_PATHS[entry.ws_id];
    if (!overrideRel) {
      remaining.push(entry);
      continue;
    }
    const overrideAbs = join(projectRoot, overrideRel);
    if (!existsSync(overrideAbs)) {
      remaining.push(entry);
      continue;
    }
    // Presence is the unblock signal — operator intent is recorded by the
    // file's existence at the scoped canonical path. Schema-strict validation
    // is delegated to the ws-2 wrapper (`pipeline-efficiency-ws2-coercive-flip-preflight.mjs`)
    // which consumes this preflight's result and applies the stricter
    // override schema + scope check before accepting the flip.
    overridden.push({
      ws_id: entry.ws_id,
      path: entry.path,
      sample_count: entry.sample_count,
      override_path: overrideAbs,
    });
  }
  return { insufficient_remaining: remaining, insufficient_overridden: overridden };
}

// =============================================================================
// Preflight steps
// =============================================================================

/**
 * Step 1 — atomic read of sentinel, enforcement-flag, and audit-log HEAD.
 *
 * "Atomic" in the spec sense (AC20.1): all three reads happen in a single
 * pass before any downstream decision is taken. True cross-file atomicity is
 * not achievable in POSIX without additional locking; the reads here are
 * ordered (sentinel → flag → HEAD) and captured as a single snapshot object
 * so downstream branches cannot re-read partway through.
 *
 * Sentinel: presence check only (file existence; contents not interpreted —
 * mere presence is the kill-switch signal per NFR-14 / EC-3).
 *
 * Enforcement-flag: delegated to as-015 reader. Absent file → advisory +
 * hardcoded-default; present + invalid → EnforcementConfigInvalidError.
 *
 * Audit-log HEAD: delegated to as-017 readAuditLogHead. Throws AuditLogError
 * when genesis anchor missing / malformed.
 *
 * @param {string} projectRoot
 * @returns {{
 *   sentinel_present: boolean,
 *   sentinel_path: string,
 *   enforcement_mode: 'advisory'|'coercive'|'off',
 *   enforcement_source: string,
 *   audit_log_head: { seq: number, prev_hash: string, source: string, head_entry: object | null },
 * }}
 */
function atomicReadPreflightInputs(projectRoot) {
  const sentinelPath = join(projectRoot, KILL_SWITCH_SENTINEL_RELATIVE);
  const sentinelPresent = existsSync(sentinelPath);

  // Enforcement-flag + source label in tandem (same underlying read).
  // Paired so the snapshot captures the flag state without a second
  // loadConfig() round-trip. getCurrentMode + getSourceLabel each call
  // loadConfig internally; passing the same implicit project root ensures
  // they agree.
  let enforcementMode;
  let enforcementSource;
  try {
    const flagPath = join(projectRoot, '.claude', 'config', 'pipeline-efficiency-enforcement.json');
    enforcementMode = getCurrentMode({ path: flagPath });
    enforcementSource = getSourceLabel({ path: flagPath });
  } catch (err) {
    if (err instanceof EnforcementConfigInvalidError) {
      // Surface as structured preflight rejection rather than letting the
      // raw EnforcementConfigInvalidError bubble to the CLI unhandled.
      const wrapped = new Error(`ENFORCEMENT_FLAG_INVALID: ${err.message}`);
      wrapped.code = PREFLIGHT_ERROR_CODES.ENFORCEMENT_FLAG_INVALID;
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }

  // Audit-log HEAD. readAuditLogHead returns {seq:0, source:'genesis', ...}
  // when the log file is absent/empty — that's a valid state (bootstrap
  // pre-first-flip) and does NOT constitute AUDIT_LOG_HEAD_UNREADABLE.
  let head;
  try {
    head = readAuditLogHead({ projectRoot });
  } catch (err) {
    const wrapped = new Error(
      `AUDIT_LOG_HEAD_UNREADABLE: ${err && err.message ? err.message : String(err)}`,
    );
    wrapped.code = PREFLIGHT_ERROR_CODES.AUDIT_LOG_HEAD_UNREADABLE;
    wrapped.cause = err;
    throw wrapped;
  }

  return {
    sentinel_present: sentinelPresent,
    sentinel_path: sentinelPath,
    enforcement_mode: enforcementMode,
    enforcement_source: enforcementSource,
    audit_log_head: {
      seq: head.seq,
      prev_hash: head.prev_hash,
      source: head.source,
      head_entry: head.head_entry,
    },
  };
}

/**
 * Step 2 — 3-way baseline presence + schema + sufficiency check (REQ-017).
 *
 * For each of the 3 canonical paths:
 *   1. atomicReadBaseline (AC17.6 fstat-stable read).
 *   2. If missing → accumulate into `missing`.
 *   3. If parse/schema/sufficiency fails → accumulate into respective lists.
 *   4. If race_abort → short-circuit return (not recoverable by more reads).
 *
 * Returns a combined result. The caller decides precedence among the
 * different failure classes:
 *   - race_abort dominates (halt immediately).
 *   - Otherwise any missing → BASELINES_INCOMPLETE.
 *   - Otherwise any schema/insufficient → structured error.
 *   - Else clean.
 *
 * @param {string} projectRoot
 * @returns {{
 *   clean: boolean,
 *   missing: Array<{ ws_id: string, path: string }>,
 *   race_abort: null | { ws_id: string, path: string, retries: number },
 *   schema_invalid: Array<{ ws_id: string, path: string, reason: string }>,
 *   insufficient: Array<{ ws_id: string, path: string, sample_count: number }>,
 *   validated: Array<{ ws_id: string, path: string, baseline: object }>,
 * }}
 */
function check3WayBaselines(projectRoot) {
  const result = {
    clean: false,
    missing: [],
    race_abort: null,
    schema_invalid: [],
    insufficient: [],
    validated: [],
  };

  for (const entry of CANONICAL_BASELINE_RELATIVE_PATHS) {
    const absolutePath = join(projectRoot, entry.relative);
    let parsed;
    try {
      parsed = atomicReadBaseline(absolutePath);
    } catch (err) {
      if (err && err.kind === 'missing') {
        result.missing.push({ ws_id: entry.ws_id, path: absolutePath });
        continue;
      }
      if (err && err.kind === 'race_abort') {
        result.race_abort = {
          ws_id: entry.ws_id,
          path: absolutePath,
          retries: err.retries,
          last_size_a: err.last_size_a,
          last_size_b: err.last_size_b,
        };
        // Short-circuit — race conditions must abort per AC17.6.
        return result;
      }
      if (err && err.kind === 'parse') {
        result.schema_invalid.push({
          ws_id: entry.ws_id,
          path: absolutePath,
          reason: `JSON parse failed: ${err.cause && err.cause.message ? err.cause.message : 'unknown'}`,
        });
        continue;
      }
      if (err && err.kind === 'io') {
        result.schema_invalid.push({
          ws_id: entry.ws_id,
          path: absolutePath,
          reason: `IO error reading baseline: ${err.cause && err.cause.message ? err.cause.message : 'unknown'}`,
        });
        continue;
      }
      throw err;
    }

    // Schema validation (as-004 baselineSchema.strict()).
    const parseResult = baselineSchema.safeParse(parsed);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      result.schema_invalid.push({
        ws_id: entry.ws_id,
        path: absolutePath,
        reason: issues,
      });
      continue;
    }

    // Sample-size sufficiency (as-004 predicate; REQ-011).
    if (!isSufficientBaseline(parseResult.data)) {
      result.insufficient.push({
        ws_id: entry.ws_id,
        path: absolutePath,
        sample_count: parseResult.data.sample_count,
      });
      continue;
    }

    result.validated.push({
      ws_id: entry.ws_id,
      path: absolutePath,
      baseline: parseResult.data,
    });
  }

  result.clean =
    result.missing.length === 0 &&
    result.race_abort === null &&
    result.schema_invalid.length === 0 &&
    result.insufficient.length === 0 &&
    result.validated.length === CANONICAL_BASELINE_RELATIVE_PATHS.length;

  return result;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run the full preflight. Non-throwing for all structured rejections — those
 * surface via `{ accepted: false, code, details }`. Unanticipated errors
 * (bugs, fs corruption) still throw so the CLI maps them to exit 1 rather
 * than 2.
 *
 * Rejection precedence (first match wins):
 *   1. SENTINEL_ACTIVE           (EC-3 — sentinel vetoes even well-formed flips)
 *   2. ENFORCEMENT_FLAG_INVALID  (flag file exists but schema-invalid)
 *   3. AUDIT_LOG_HEAD_UNREADABLE (genesis missing / HEAD corrupt)
 *   4. BASELINE_RACE_ABORT       (AC17.6 — retry ceiling exhausted)
 *   5. BASELINES_INCOMPLETE      (EC-9 — any of 3 missing)
 *   6. BASELINE_SCHEMA_INVALID   (any of 3 schema-invalid)
 *   7. BASELINE_INSUFFICIENT     (any of 3 below REQ-011 sufficiency)
 *
 * @param {{ projectRoot?: string }} [opts]
 * @returns {{
 *   accepted: boolean,
 *   code: string,
 *   details: object,
 *   inputs?: object,
 *   baselines?: object,
 *   substrate?: { mismatch: boolean, message?: string },
 *   audit?: { appended: boolean, error?: { code: string, message: string } },
 * }}
 */
export function runPreflight(opts = {}) {
  const projectRoot = resolveProjectRoot(opts);

  // Substrate probe runs first (non-blocking) so its warning is always
  // visible in the result envelope — even when the preflight accepts.
  const substrate = substrateProbe(projectRoot);

  // Step 1: atomic reads. May throw wrapped structured errors.
  let inputs;
  try {
    inputs = atomicReadPreflightInputs(projectRoot);
  } catch (err) {
    if (err && err.code && Object.values(PREFLIGHT_ERROR_CODES).includes(err.code)) {
      const audit = auditLogRejection(projectRoot, err.code, {
        reason: err.message,
      });
      return {
        accepted: false,
        code: err.code,
        details: { message: err.message },
        substrate,
        audit,
      };
    }
    throw err;
  }

  // Sentinel check (EC-3) — highest precedence rejection.
  if (inputs.sentinel_present) {
    const audit = auditLogRejection(projectRoot, PREFLIGHT_ERROR_CODES.SENTINEL_ACTIVE, {
      sentinel_path: inputs.sentinel_path,
      enforcement_mode: inputs.enforcement_mode,
      audit_head_seq: inputs.audit_log_head.seq,
    });
    return {
      accepted: false,
      code: PREFLIGHT_ERROR_CODES.SENTINEL_ACTIVE,
      details: {
        sentinel_path: inputs.sentinel_path,
        message:
          'Kill-switch sentinel present at canonical path — flip rejected. ' +
          'Remove the sentinel via `git commit -S` (operator-only) before retrying.',
      },
      inputs,
      substrate,
      audit,
    };
  }

  // Step 2: 3-way baseline gate.
  const baselines = check3WayBaselines(projectRoot);

  if (baselines.race_abort) {
    const audit = auditLogRejection(projectRoot, PREFLIGHT_ERROR_CODES.BASELINE_RACE_ABORT, {
      ws_id: baselines.race_abort.ws_id,
      path: baselines.race_abort.path,
      retries: baselines.race_abort.retries,
    });
    return {
      accepted: false,
      code: PREFLIGHT_ERROR_CODES.BASELINE_RACE_ABORT,
      details: baselines.race_abort,
      inputs,
      baselines,
      substrate,
      audit,
    };
  }

  if (baselines.missing.length > 0) {
    const missingWsIds = baselines.missing.map((m) => m.ws_id);
    const audit = auditLogRejection(
      projectRoot,
      PREFLIGHT_ERROR_CODES.BASELINES_INCOMPLETE,
      {
        missing_baselines: missingWsIds,
        missing_paths: baselines.missing.map((m) => m.path),
      },
    );
    return {
      accepted: false,
      code: PREFLIGHT_ERROR_CODES.BASELINES_INCOMPLETE,
      details: {
        missing_baselines: missingWsIds,
        missing_paths: baselines.missing.map((m) => m.path),
        message:
          `Partial rollout: baselines missing for ${missingWsIds.join(', ')}. ` +
          `All three canonical baselines (ws-1, ws-2, ws-3) must be published ` +
          `before coercive-flip is permitted (EC-9).`,
      },
      inputs,
      baselines,
      substrate,
      audit,
    };
  }

  if (baselines.schema_invalid.length > 0) {
    const audit = auditLogRejection(
      projectRoot,
      PREFLIGHT_ERROR_CODES.BASELINE_SCHEMA_INVALID,
      { invalid_baselines: baselines.schema_invalid },
    );
    return {
      accepted: false,
      code: PREFLIGHT_ERROR_CODES.BASELINE_SCHEMA_INVALID,
      details: { invalid_baselines: baselines.schema_invalid },
      inputs,
      baselines,
      substrate,
      audit,
    };
  }

  if (baselines.insufficient.length > 0) {
    // AC10.3 / AC10.4 override-unblock branch. A scoped per-ws override file
    // at the canonical path removes that ws from the INSUFFICIENT rejection
    // surface. If every insufficient ws is overridden, acceptance proceeds
    // via the normal accept path below. The original `baselines.insufficient`
    // array is preserved on the baselines object for diagnostics; the
    // override-partition result is surfaced under `baselines.override`.
    const { insufficient_remaining, insufficient_overridden } =
      partitionInsufficientByOverride(projectRoot, baselines.insufficient);
    baselines.override = {
      insufficient_overridden,
      insufficient_remaining,
    };

    if (insufficient_remaining.length > 0) {
      const audit = auditLogRejection(
        projectRoot,
        PREFLIGHT_ERROR_CODES.BASELINE_INSUFFICIENT,
        {
          insufficient_baselines: insufficient_remaining,
          insufficient_overridden,
        },
      );
      return {
        accepted: false,
        code: PREFLIGHT_ERROR_CODES.BASELINE_INSUFFICIENT,
        details: {
          insufficient_baselines: insufficient_remaining,
          insufficient_overridden,
          message:
            'One or more baselines fail the REQ-011 sufficiency predicate ' +
            '(sample_count >= 10 OR window span >= 30d).',
        },
        inputs,
        baselines,
        substrate,
        audit,
      };
    }
    // All insufficient entries were overridden → fall through to accept.
  }

  // All checks passed → accept + audit-log the accepted flip.
  const audit = auditLogAcceptance(projectRoot, {
    baselines_validated: baselines.validated.map((v) => ({
      ws_id: v.ws_id,
      sample_count: v.baseline.sample_count,
      measurement_window_start: v.baseline.measurement_window_start,
      measurement_window_end: v.baseline.measurement_window_end,
    })),
    prior_mode: inputs.enforcement_mode,
    prior_source: inputs.enforcement_source,
  });

  return {
    accepted: true,
    code: 'ACCEPTED',
    details: {
      message: 'Preflight passed: all 3 canonical baselines present, schema-valid, and sufficient.',
    },
    inputs,
    baselines,
    substrate,
    audit,
  };
}

// =============================================================================
// CLI entrypoint
// =============================================================================

/**
 * CLI entrypoint. JSON output on stdout (acceptance envelope), structured
 * error summary on stderr for rejections. Exit codes per the module header.
 *
 * Invocation shapes:
 *   node pipeline-efficiency-coercive-flip-preflight.mjs
 *   node pipeline-efficiency-coercive-flip-preflight.mjs --json
 *   node pipeline-efficiency-coercive-flip-preflight.mjs --project-root <path>
 */
function runCli(argv) {
  const args = argv.slice(2);
  const jsonMode = args.includes('--json');
  const prIdx = args.indexOf('--project-root');
  const projectRoot = prIdx >= 0 && args[prIdx + 1] ? args[prIdx + 1] : undefined;

  let result;
  try {
    result = runPreflight({ projectRoot });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (jsonMode) {
      process.stdout.write(
        JSON.stringify(
          {
            accepted: false,
            code: 'UNEXPECTED_ERROR',
            details: { message },
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(`UNEXPECTED_ERROR: ${message}\n`);
    }
    return EXIT_UNEXPECTED;
  }

  // Substrate warning surfaces to stderr even on accept (non-blocking).
  if (result.substrate && result.substrate.mismatch) {
    process.stderr.write(`WARN ${result.substrate.message}\n`);
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (result.accepted) {
    process.stdout.write(
      `ACCEPTED prior_mode=${result.inputs.enforcement_mode} ` +
        `prior_source=${result.inputs.enforcement_source} ` +
        `audit_appended=${result.audit ? result.audit.appended : 'unknown'}\n`,
    );
  } else {
    const detailSummary = JSON.stringify(result.details || {});
    process.stderr.write(
      `REJECTED ${result.code} ${detailSummary}` +
        (result.audit && !result.audit.appended
          ? ` audit_error=${result.audit.error ? result.audit.error.code : 'unknown'}`
          : '') +
        '\n',
    );
  }

  return result.accepted ? EXIT_ACCEPTED : EXIT_REJECTED;
}

// Guard against accidental invocation during import (ESM equivalent of
// Node's `require.main === module` CJS idiom).
//
// cr-shadow-m2:
//   Earlier revision shadowed `resolve` with a local object literal
//   (`const { resolve } = { resolve: (p) => ... }`) that handled only
//   absolute-vs-cwd prefixing. Aligned with sibling pattern in
//   `completion-verifier-hooks.mjs:156-162 isDirectInvocation()` — use
//   `node:path` `resolve` for correct normalization (`..`, symlinks, Windows
//   drive letters) and `node:url` `fileURLToPath` for safe `import.meta.url`
//   conversion (handles percent-encoded paths, cross-platform).
const isDirectInvocation = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const thisFilePath = fileURLToPath(import.meta.url);
  // process.argv[1] may be relative (`node ./script.mjs`) — resolve to abs
  // against cwd. resolve() is idempotent on already-absolute paths.
  const entryAbs = entry.startsWith(sep) ? entry : resolve(process.cwd(), entry);
  return thisFilePath === entryAbs;
})();

if (isDirectInvocation) {
  const code = runCli(process.argv);
  process.exit(code);
}
