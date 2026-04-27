#!/usr/bin/env node

/**
 * pipeline-efficiency-ws2-baseline-accumulator.mjs
 *
 * ws-2 Practice-2.4 advisory-phase baseline accumulator. Reads the
 * pipeline-efficiency audit log, counts `test_writer_unlock` +
 * `test_writer_unlock_refence` events (scoped to the ws-2 gate), and writes
 * `.claude/metrics/pipeline-efficiency-ws2-baseline.json` with the 8-field
 * baseline shape validated by `baselineSchema` (ws-1 as-004).
 *
 * Implements: REQ-011 ws-2 scope
 *   - AC10.1: accumulator reads audit-log event stream; writes canonical ws-2
 *             baseline file with all 8 schema fields; `sample_count`
 *             monotonically increases across invocations.
 *   - AC10.5: path is `.claude/metrics/pipeline-efficiency-ws2-baseline.json`
 *             (short-form ws-id). Legacy `pipeline-efficiency-practice-2-4-*`
 *             is never written.
 *
 * Spec: sg-pipeline-efficiency-ws2-practice-2.4 (as-010)
 *
 * Canonical path (authoritative — matches ws-1 as-020 3-workstream preflight):
 *   `.claude/metrics/pipeline-efficiency-ws2-baseline.json`
 *
 * Event-class scope:
 *   - `test_writer_unlock`          — counts as one sample per unlock event
 *                                     (an operator-initiated bug-fix hybrid
 *                                     dispatch).
 *   - `test_writer_unlock_refence`  — counts as a completion signal; together
 *                                     with the unlock seed it confirms the
 *                                     workstream reached a re-fence state
 *                                     (spec-complete / test-pass / version-
 *                                     bump / workstream-rotate / session-end).
 *     Re-fence entries alone (without a matching unlock) are still counted as
 *     advisory-mode activity per REQ-011 (sample_count monotonically
 *     increases with audit-log activity).
 *
 * Measurement window:
 *   - `measurement_window_start` = earliest qualifying entry's timestamp, or
 *     the previous baseline's `measurement_window_start` if it exists and is
 *     earlier (monotonic: the window never contracts).
 *   - `measurement_window_end`   = latest qualifying entry's timestamp, or
 *     `published_at` if no qualifying entries exist.
 *   - If the audit log is empty (no qualifying entries), window spans a
 *     zero-length segment anchored at `published_at` — AC10.1 still demands
 *     all 8 fields populated; the sufficiency predicate (AC10.3) will reject
 *     a zero-span / zero-sample baseline.
 *
 * Monotonicity:
 *   - When the previous baseline file exists and is schema-valid, the
 *     accumulator compares its `sample_count` against the newly-computed
 *     count. If the computed value would regress (e.g., audit-log rotation
 *     left a shorter chain in-place), the accumulator refuses to write and
 *     exits with code 2 `BASELINE_MONOTONICITY_VIOLATION`. This is a safety
 *     rail against an audit-log rewind overwriting a mature baseline.
 *
 * Idempotency:
 *   - Running the accumulator twice in a row with no new audit-log entries
 *     between invocations is a no-op for `sample_count` (it stays at the
 *     same value) but the `published_at` field is refreshed. The baseline
 *     content-hash changes; this is expected and does not violate the
 *     monotonicity rail (sample_count is unchanged).
 *
 * Atomic write:
 *   - Writes are atomic via write-to-temp-and-rename
 *     (`pipeline-efficiency-ws2-baseline.json.tmp` → rename). This matches
 *     the AC17.6 fstat-stable read pattern used by the as-020 preflight:
 *     preflight readers never see a torn JSON.
 *
 * CLI exit codes:
 *   0  — SUCCESS (baseline written or no-op when identical-state)
 *   2  — BASELINE_MONOTONICITY_VIOLATION / AUDIT_LOG_UNREADABLE /
 *        AUDIT_LOG_LINE_MALFORMED (structured rejection — baseline NOT
 *        written)
 *   1  — UNEXPECTED_ERROR (runtime bug / fs corruption)
 *
 * Programmatic callers:
 *   import { runAccumulator } from './pipeline-efficiency-ws2-baseline-accumulator.mjs';
 *   const result = runAccumulator({ projectRoot });
 *   // result: { ok: boolean, code: string, baseline, audit_stats, details }
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getCanonicalProjectDir,
  CanonicalProjectDirError,
} from './lib/hook-utils.mjs';
import { AUDIT_LOG_RELATIVE_PATH } from './pipeline-efficiency-audit-log.mjs';
import {
  baselineSchema,
  MIN_SAMPLE_COUNT,
  MIN_WINDOW_DAYS,
  MS_PER_DAY,
} from './lib/schemas/baseline.schema.mjs';

// =============================================================================
// Constants — canonical paths
// =============================================================================

/**
 * Canonical ws-2 baseline path (AC10.5; ws-1 as-020 consumer).
 *
 * Hard-coded by contract. Legacy pattern
 * `pipeline-efficiency-practice-2-4-baseline.json` is intentionally NOT
 * written — investigation Pass 1 inv-contract-a8f3c2 / Pass 2 inv-contract-4e8b16
 * renamed to the canonical short-form ws-id path.
 */
export const WS2_BASELINE_RELATIVE_PATH =
  '.claude/metrics/pipeline-efficiency-ws2-baseline.json';

/** Canonical gate name embedded in the baseline file (REQ-011 §Baselines). */
export const WS2_GATE_NAME = 'pipeline-efficiency-ws2';

/**
 * Event classes counted toward the ws-2 advisory-phase sample.
 *
 * Both `test_writer_unlock` and `test_writer_unlock_refence` belong to the
 * Practice-2.4 bug-fix hybrid flow. Counting both ensures `sample_count`
 * reflects real workstream volume, not just the unlock seed — a workstream
 * that unlocks and completes produces at least one of each, and partial
 * flows (unlock without re-fence, or re-fence-only bookkeeping during
 * recovery) are still counted as advisory activity.
 */
export const WS2_AUDIT_EVENT_CLASSES = Object.freeze([
  'test_writer_unlock',
  'test_writer_unlock_refence',
]);

// =============================================================================
// Constants — CLI exit codes
// =============================================================================

const EXIT_SUCCESS = 0;
const EXIT_UNEXPECTED = 1;
const EXIT_REJECTED = 2;

// =============================================================================
// Structured-error codes
// =============================================================================

export const ACCUMULATOR_ERROR_CODES = Object.freeze({
  AUDIT_LOG_UNREADABLE: 'AUDIT_LOG_UNREADABLE',
  AUDIT_LOG_LINE_MALFORMED: 'AUDIT_LOG_LINE_MALFORMED',
  BASELINE_MONOTONICITY_VIOLATION: 'BASELINE_MONOTONICITY_VIOLATION',
  BASELINE_WRITE_FAILED: 'BASELINE_WRITE_FAILED',
});

// =============================================================================
// Structured error
// =============================================================================

/**
 * Structured accumulator error. Callers branch on `.code` (one of
 * ACCUMULATOR_ERROR_CODES).
 */
export class AccumulatorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AccumulatorError';
    this.code = code;
    this.details = details;
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Resolve the project root. Prefers the canonical realpath root; falls back
 * to cwd on CanonicalProjectDirError. Mirrors the pattern used by
 * `pipeline-efficiency-coercive-flip-preflight.mjs`.
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
 * Determine the operator label for the baseline `operator` field.
 *
 * Precedence:
 *   1. explicit `opts.operator` (test fixtures, overrides)
 *   2. `process.env.USER` (local-single-maintainer substrate per
 *      pipeline-efficiency-enforcement.json)
 *   3. fallback string (never empty — schema requires `operator.min(1)`)
 *
 * @param {{ operator?: string }} [opts]
 * @returns {string}
 */
function resolveOperator(opts = {}) {
  if (opts.operator && typeof opts.operator === 'string' && opts.operator.length > 0) {
    return opts.operator;
  }
  const envOperator = process.env.USER;
  if (envOperator && envOperator.length > 0) {
    return envOperator;
  }
  return 'agent';
}

/**
 * Read the audit log and return all lines that match the ws-2 event-class
 * scope. Non-matching classes are skipped silently.
 *
 * Returns an array of parsed entries (shape-loose — schema-enforced by
 * `appendAuditEntry` at write time; re-validating every line on read would
 * double the write cost for no new information).
 *
 * Throws structured `AccumulatorError` on:
 *   - audit-log file missing or unreadable (AUDIT_LOG_UNREADABLE)
 *   - line that fails JSON.parse (AUDIT_LOG_LINE_MALFORMED)
 *
 * An empty log (file absent or zero lines) returns `[]` without throwing —
 * the first accumulator invocation on a fresh project is a valid state
 * producing a zero-sample baseline.
 *
 * @param {string} projectRoot
 * @returns {Array<object>}
 */
function readQualifyingAuditEntries(projectRoot) {
  const logPath = join(projectRoot, AUDIT_LOG_RELATIVE_PATH);

  if (!existsSync(logPath)) {
    // Empty / fresh project is valid; return empty sample.
    return [];
  }

  let raw;
  try {
    raw = readFileSync(logPath, 'utf-8');
  } catch (err) {
    throw new AccumulatorError(
      ACCUMULATOR_ERROR_CODES.AUDIT_LOG_UNREADABLE,
      `Cannot read audit log at ${logPath}: ${err && err.message ? err.message : String(err)}`,
      { path: logPath, cause: err && err.message ? err.message : String(err) }
    );
  }

  if (raw.length === 0) return [];

  const lines = raw.split('\n').filter((l) => l.length > 0);
  const qualifying = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new AccumulatorError(
        ACCUMULATOR_ERROR_CODES.AUDIT_LOG_LINE_MALFORMED,
        `Audit log line ${i + 1} is not valid JSON: ${err && err.message ? err.message : String(err)}`,
        { path: logPath, line_index: i + 1, cause: err && err.message ? err.message : String(err) }
      );
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (WS2_AUDIT_EVENT_CLASSES.includes(parsed.event_class)) {
      qualifying.push(parsed);
    }
  }
  return qualifying;
}

/**
 * Read the previous baseline file (if any) and return its parsed,
 * schema-validated contents. Returns `null` if absent, unparsable, or
 * shape-invalid — a corrupt previous baseline does NOT block progress; we
 * simply do not propagate its `measurement_window_start` into the new one.
 *
 * Monotonicity enforcement uses this value as the floor: the new
 * `sample_count` must be `>=` the previous value.
 *
 * @param {string} projectRoot
 * @returns {object | null}
 */
function readPreviousBaseline(projectRoot) {
  const baselinePath = join(projectRoot, WS2_BASELINE_RELATIVE_PATH);
  if (!existsSync(baselinePath)) return null;
  let raw;
  try {
    raw = readFileSync(baselinePath, 'utf-8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = baselineSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

/**
 * Derive the baseline fields from the audit-log entries + previous baseline.
 *
 * @param {Array<object>} entries    qualifying audit entries
 * @param {object | null} previous   previous baseline (null on first run)
 * @param {{ now: string, operator: string }} opts
 * @returns {object} baseline fields (schema-valid before return)
 */
function deriveBaseline(entries, previous, opts) {
  const sampleCount = entries.length;

  // Timestamp window. Use earliest/latest qualifying entry timestamp; fall
  // back to `opts.now` when no entries exist (zero-sample baseline).
  let earliestMs = null;
  let latestMs = null;
  for (const e of entries) {
    const t = e && typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(t)) continue;
    if (earliestMs === null || t < earliestMs) earliestMs = t;
    if (latestMs === null || t > latestMs) latestMs = t;
  }
  const nowMs = Date.parse(opts.now);

  const prevStartMs = previous ? Date.parse(previous.measurement_window_start) : NaN;
  const rawStartMs = earliestMs !== null ? earliestMs : prevStartMs;
  let windowStartMs = Number.isFinite(rawStartMs) ? rawStartMs : nowMs;
  if (Number.isFinite(prevStartMs) && prevStartMs < windowStartMs) {
    windowStartMs = prevStartMs;
  }

  // window_end must be >= window_start (schema refinement). If the only
  // entries are older than a monotonic window_start pin, use window_start.
  const rawEndMs = latestMs !== null ? latestMs : nowMs;
  const windowEndMs = Math.max(windowStartMs, Number.isFinite(rawEndMs) ? rawEndMs : nowMs);

  // False-positive / catch rates are zero at this layer — the advisory-phase
  // baseline does not have an independent oracle for the Practice-2.4 gate
  // in this evidence run (same rationale as ws-1 as-026 scaffold; ws-2
  // metrics publisher (as-011) will refine these rates with operator review
  // once the sample matures). Matching ws-1 as-026 scaffold conventions
  // keeps the two baselines structurally identical for the 3-way preflight.
  //
  // SELF-RESOLVED(code): ws-1 as-026 scaffold establishes 0 as the baseline
  // value until an `observed_rate` is published; refined later by as-011
  // publisher. In-repo evidence:
  //   - ws-1 as-026 scaffold precedent — same two fields emitted as 0 on
  //     first publication (advisory-phase invariant shared by both
  //     workstreams).
  //   - Atomic spec `.claude/specs/groups/sg-pipeline-efficiency-ws2-practice-2.4/
  //     atomic/as-011-*.md` Decision Log records that the publisher (as-011)
  //     is the refinement owner — this accumulator's job is to emit the
  //     schema-valid scaffold with `sample_count` monotonic.
  //   - `baselineSchema` (lib/schemas/baseline.schema.mjs) accepts 0 as a
  //     valid rate; `isSufficientBaseline` (same file) gates on
  //     `sample_count >= 10 && window >= 30d`, NOT on fp/catch specifically.
  // The rates therefore correctly default to 0 here until the publisher
  // overrides them with operator-classified signal.
  const baseline = {
    gate_name: WS2_GATE_NAME,
    false_positive_rate: 0,
    catch_rate: 0,
    sample_count: sampleCount,
    measurement_window_start: new Date(windowStartMs).toISOString(),
    measurement_window_end: new Date(windowEndMs).toISOString(),
    published_at: opts.now,
    operator: opts.operator,
  };

  return baseline;
}

/**
 * Enforce sample_count monotonicity against the previous baseline. Returns
 * `{ ok: true }` when no previous or when the new sample_count is >= the
 * previous; otherwise throws an AccumulatorError.
 *
 * @param {object} next
 * @param {object | null} previous
 */
function assertMonotonicity(next, previous) {
  if (!previous) return;
  if (next.sample_count < previous.sample_count) {
    throw new AccumulatorError(
      ACCUMULATOR_ERROR_CODES.BASELINE_MONOTONICITY_VIOLATION,
      `BASELINE_MONOTONICITY_VIOLATION: new sample_count=${next.sample_count} < ` +
        `previous sample_count=${previous.sample_count}. Refusing to overwrite a ` +
        `mature baseline with a shorter audit-log view. Operator should inspect ` +
        `the audit-log for rotation / truncation artifacts before retrying.`,
      {
        new_sample_count: next.sample_count,
        previous_sample_count: previous.sample_count,
      }
    );
  }
}

/**
 * Write the baseline via write-to-temp-and-rename. Produces the file atomically
 * w.r.t. any concurrent fstat-stable reader (AC17.6 in the ws-1 preflight).
 *
 * @param {string} projectRoot
 * @param {object} baseline
 */
function atomicWriteBaseline(projectRoot, baseline) {
  const baselinePath = join(projectRoot, WS2_BASELINE_RELATIVE_PATH);
  const tmpPath = `${baselinePath}.tmp`;
  const dir = dirname(baselinePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  try {
    writeFileSync(tmpPath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, baselinePath);
  } catch (err) {
    // Clean up orphan tmp file on write / rename failure.
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // swallow — primary error is the one that matters
    }
    throw new AccumulatorError(
      ACCUMULATOR_ERROR_CODES.BASELINE_WRITE_FAILED,
      `BASELINE_WRITE_FAILED: could not atomic-write ${baselinePath}: ${err && err.message ? err.message : String(err)}`,
      { path: baselinePath, cause: err && err.message ? err.message : String(err) }
    );
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run the accumulator: read audit log → derive baseline → enforce
 * monotonicity → atomic-write baseline file.
 *
 * Non-throwing for all structured rejections — those surface via
 * `{ ok: false, code, details }`. Unanticipated errors throw so the CLI maps
 * them to exit 1.
 *
 * @param {{ projectRoot?: string, operator?: string, now?: string }} [opts]
 * @returns {{
 *   ok: boolean,
 *   code: string,
 *   baseline?: object,
 *   previous_baseline?: object | null,
 *   audit_stats?: { qualifying_count: number, event_classes: string[] },
 *   details?: object,
 * }}
 */
export function runAccumulator(opts = {}) {
  const projectRoot = resolveProjectRoot(opts);
  const now = opts.now || new Date().toISOString();
  const operator = resolveOperator(opts);

  // Step 1: read audit log (scoped to ws-2 event classes).
  let entries;
  try {
    entries = readQualifyingAuditEntries(projectRoot);
  } catch (err) {
    if (err instanceof AccumulatorError) {
      return {
        ok: false,
        code: err.code,
        details: { message: err.message, ...err.details },
      };
    }
    throw err;
  }

  // Step 2: read previous baseline (if any) for monotonicity floor +
  // monotonic window_start.
  const previous = readPreviousBaseline(projectRoot);

  // Step 3: derive baseline fields.
  const baseline = deriveBaseline(entries, previous, { now, operator });

  // Step 4: monotonicity gate — refuse to write a regressed sample_count.
  try {
    assertMonotonicity(baseline, previous);
  } catch (err) {
    if (err instanceof AccumulatorError) {
      return {
        ok: false,
        code: err.code,
        baseline,
        previous_baseline: previous,
        audit_stats: {
          qualifying_count: entries.length,
          event_classes: [...WS2_AUDIT_EVENT_CLASSES],
        },
        details: { message: err.message, ...err.details },
      };
    }
    throw err;
  }

  // Step 5: schema-validate before writing (defense-in-depth — a derivation
  // bug that would emit a shape-invalid baseline must fail BEFORE it poisons
  // the file consumed by the ws-1 as-020 preflight).
  const parseResult = baselineSchema.safeParse(baseline);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(
      `AccumulatorInternalError: derived baseline fails schema: ${issues}. ` +
        `This is a code bug in deriveBaseline(), not a runtime condition.`
    );
  }

  // Step 6: atomic write.
  try {
    atomicWriteBaseline(projectRoot, baseline);
  } catch (err) {
    if (err instanceof AccumulatorError) {
      return {
        ok: false,
        code: err.code,
        baseline,
        previous_baseline: previous,
        audit_stats: {
          qualifying_count: entries.length,
          event_classes: [...WS2_AUDIT_EVENT_CLASSES],
        },
        details: { message: err.message, ...err.details },
      };
    }
    throw err;
  }

  return {
    ok: true,
    code: 'SUCCESS',
    baseline,
    previous_baseline: previous,
    audit_stats: {
      qualifying_count: entries.length,
      event_classes: [...WS2_AUDIT_EVENT_CLASSES],
    },
    details: {
      message: `baseline written to ${join(projectRoot, WS2_BASELINE_RELATIVE_PATH)}`,
      sufficiency: {
        min_sample_count: MIN_SAMPLE_COUNT,
        min_window_days: MIN_WINDOW_DAYS,
        sample_count: baseline.sample_count,
        window_days: Math.floor(
          (Date.parse(baseline.measurement_window_end) -
            Date.parse(baseline.measurement_window_start)) /
            MS_PER_DAY
        ),
      },
    },
  };
}

// =============================================================================
// CLI entrypoint
// =============================================================================

function runCli(argv) {
  const args = argv.slice(2);
  const jsonMode = args.includes('--json');
  const prIdx = args.indexOf('--project-root');
  const projectRoot = prIdx >= 0 && args[prIdx + 1] ? args[prIdx + 1] : undefined;
  const opIdx = args.indexOf('--operator');
  const operator = opIdx >= 0 && args[opIdx + 1] ? args[opIdx + 1] : undefined;

  let result;
  try {
    result = runAccumulator({ projectRoot, operator });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (jsonMode) {
      process.stdout.write(
        JSON.stringify(
          { ok: false, code: 'UNEXPECTED_ERROR', details: { message } },
          null,
          2
        ) + '\n'
      );
    } else {
      process.stderr.write(`UNEXPECTED_ERROR: ${message}\n`);
    }
    return EXIT_UNEXPECTED;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (result.ok) {
    process.stdout.write(
      `SUCCESS sample_count=${result.baseline.sample_count} ` +
        `window=${result.baseline.measurement_window_start}..${result.baseline.measurement_window_end} ` +
        `path=${WS2_BASELINE_RELATIVE_PATH}\n`
    );
  } else {
    const detailSummary = JSON.stringify(result.details || {});
    process.stderr.write(`REJECTED ${result.code} ${detailSummary}\n`);
  }

  return result.ok ? EXIT_SUCCESS : EXIT_REJECTED;
}

// Direct-invocation guard (ESM equivalent of `require.main === module`).
const isDirectInvocation = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const thisFilePath = fileURLToPath(import.meta.url);
  const entryAbs = entry.startsWith(sep) ? entry : resolve(process.cwd(), entry);
  return thisFilePath === entryAbs;
})();

if (isDirectInvocation) {
  const code = runCli(process.argv);
  process.exit(code);
}
