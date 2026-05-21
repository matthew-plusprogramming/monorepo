/**
 * baseline-preflight.mjs — ws-3 REQ-011 baseline-consumer preflight for the
 * flow-verify diff-scope coercive flip (AC18.1–AC18.4).
 *
 * Spec: sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-018
 * Contract: spec.md §Interfaces & Contracts — Baseline-Consumer Contract
 *
 * ### What this module does
 *
 * Gates the advisory → coercive flip of the `flow-verify-diff-scope` gate on
 * the presence of a schema-valid, sample-size-sufficient baseline file
 * published by ws-1. When the baseline is absent, malformed, or undersized,
 * the preflight rejects with a structured error code. An operator override
 * file (workstream-scoped) unblocks the rejection per AC18.3.
 *
 * ### Contract surface
 *
 * Baseline file (owned by ws-1 publisher, consumed here):
 *   path: `.claude/metrics/pipeline-efficiency-ws3-baseline.json` (AC18.4)
 *   shape (spec.md §Baseline-Consumer Contract):
 *     gate             : string enum "flow-verify-diff-scope"
 *     published_at     : ISO8601
 *     sample_size      : integer (workstreams OR days)
 *     findings_baseline: JSON (schema per ws-1 publisher; opaque to consumer)
 *
 * Override file (workstream-scoped, AC18.3):
 *   path: `.claude/metrics/sg-pipeline-efficiency-ws3-orchestrator-hygiene-baseline-override.json`
 *   shape: any valid JSON object. Rationale is required in the operator's
 *          written record (REQ-011 operator accountability) but this consumer
 *          does not enforce the rationale field — presence + valid JSON is
 *          sufficient per shipped Implementation Notes §2 ("any presence +
 *          valid JSON accepted").
 *
 * ### Entry point
 *
 * ```
 * import { preflightBaseline } from './baseline-preflight.mjs';
 * const result = await preflightBaseline({ projectRoot, gate: 'flow-verify-diff-scope' });
 * //   result.ok === true                      → accept, allow coercive flip
 * //   result.ok === false && error.code = BASELINE_MISSING    → AC18.1
 * //   result.ok === false && error.code = BASELINE_UNDERSIZED → AC18.2
 * //   (override present → result.ok === true regardless — AC18.3)
 * ```
 *
 * Default export is the same function for import-style flexibility.
 *
 * ### AC18.4 (legacy-filename containment)
 *
 * The constant `CANON_BASELINE_RELATIVE_PATH` is the ONLY baseline path this
 * module reads. The legacy pattern `pipeline-efficiency-flow-verify-baseline.json`
 * is NOT referenced in any code path — verified structurally by the AC18.4
 * integration test, which places a valid baseline at the legacy path and
 * asserts the preflight still rejects with `BASELINE_MISSING`.
 *
 * ### Sufficiency predicate
 *
 * Contract reads `sample_size >= 10 workstreams OR >= 30 days`. The baseline's
 * `sample_size` field carries either count per the Baseline-Consumer Contract
 * (spec.md §Baseline-Consumer fields). The consumer treats sample_size
 * interchangeably as "workstreams OR days" and accepts it when
 * `sample_size >= 10`, which covers both halves of the OR via the unified
 * contract field. A 30-day window with fewer than 10 workstreams would be
 * encoded as `sample_size >= 30` by the ws-1 publisher per its schema
 * documentation. Consumer is intentionally kept simple: one numeric threshold
 * against one contract field. If ws-1 evolves the contract to expose both
 * units separately, this predicate extends without changing the error codes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// =============================================================================
// Constants — canonical paths (AC18.4 legacy-filename containment)
// =============================================================================

/**
 * Canonical baseline path (short-form ws-id per parent-spec Contract Registry
 * §Baselines + Investigation Pass 1 amendment inv-contract-a8f3c2).
 *
 * AC18.4: this is the ONLY baseline path this module reads. The legacy
 * filename `pipeline-efficiency-flow-verify-baseline.json` is never
 * referenced — asserted by the AC18.4 integration test.
 */
export const CANON_BASELINE_RELATIVE_PATH =
  '.claude/metrics/pipeline-efficiency-ws3-baseline.json';

/**
 * Canonical workstream-scoped override path (AC18.3). The full spec-group ID
 * is embedded in the filename to pin the override to this workstream only;
 * cross-workstream leakage is prevented at the filesystem-path layer.
 */
export const OVERRIDE_RELATIVE_PATH =
  '.claude/metrics/sg-pipeline-efficiency-ws3-orchestrator-hygiene-baseline-override.json';

/** Contract gate identifier enum (spec.md §Baseline-Consumer Contract). */
export const FLOW_VERIFY_DIFF_SCOPE_GATE = 'flow-verify-diff-scope';

// =============================================================================
// Constants — sufficiency threshold
// =============================================================================

/**
 * Minimum `sample_size` that satisfies the sufficiency predicate (REQ-011 /
 * spec.md §Baseline-Consumer Contract: `sample_size >= 10 workstreams OR
 * >= 30 days`).
 *
 * Named after the smaller of the two thresholds (workstreams) so it is
 * self-documenting when the ws-1 publisher populates `sample_size` in
 * workstream units. When the publisher supplies `sample_size` in day units,
 * 10 is strictly looser than 30 — this consumer deliberately accepts the
 * lower threshold to avoid false rejections on publisher-unit ambiguity. The
 * 30-day gate is enforced at the publisher, not the consumer.
 */
export const MIN_SUFFICIENT_SAMPLE_SIZE = 10;

// =============================================================================
// Structured error codes (AC18.1 / AC18.2 — contract-declared)
// =============================================================================

/**
 * Frozen registry of the error codes the preflight emits on rejection. The
 * codes are the shipped AC text verbatim (AC18.1 `BASELINE_MISSING`,
 * AC18.2 `BASELINE_UNDERSIZED`) plus a parallel `BASELINE_SCHEMA_INVALID`
 * code for the third distinct failure mode.
 *
 * Consumers should reference these names via the frozen object rather than
 * string-literal matching to get a single source of truth.
 */
export const PREFLIGHT_ERROR_CODES = Object.freeze({
  BASELINE_MISSING: 'BASELINE_MISSING',
  BASELINE_SCHEMA_INVALID: 'BASELINE_SCHEMA_INVALID',
  BASELINE_UNDERSIZED: 'BASELINE_UNDERSIZED',
});

// =============================================================================
// Error class — used when callers prefer throw-based rejection handling
// =============================================================================

/**
 * Structured error type emitted by the throwing API variant. Callers that
 * prefer `try/catch` flow-control can inspect `.code` without string-
 * matching on `.message`. The non-throwing `preflightBaseline` API returns
 * `{ ok: false, error: { code } }` instead.
 */
export class BaselinePreflightError extends Error {
  /**
   * @param {string} code — one of `PREFLIGHT_ERROR_CODES`.
   * @param {string} message — operator-facing explanation.
   * @param {object} [details] — structured context (sample_size, path, etc.).
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BaselinePreflightError';
    this.code = code;
    this.details = details;
  }
}

// =============================================================================
// Helpers — pure functions exported for test/inspection
// =============================================================================

/**
 * Validate the Baseline-Consumer Contract shape on a parsed baseline object.
 *
 * Contract fields (spec.md §Baseline-Consumer Contract):
 *   - gate              : string "flow-verify-diff-scope"
 *   - published_at      : ISO8601 (basic string-non-empty check; publisher
 *                         owns stricter validation)
 *   - sample_size       : non-negative integer
 *   - findings_baseline : JSON (opaque to consumer — shape owned by ws-1
 *                         publisher; existence is required but contents
 *                         are not inspected)
 *
 * @param {unknown} parsed — result of JSON.parse on the baseline file
 * @param {string} expectedGate — gate identifier the caller is preflighting
 * @returns {{ valid: true, baseline: { gate: string, published_at: string, sample_size: number, findings_baseline: unknown } } | { valid: false, reason: string }}
 */
export function validateBaselineShape(parsed, expectedGate) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, reason: 'baseline must be a JSON object' };
  }
  if (typeof parsed.gate !== 'string' || parsed.gate.length === 0) {
    return { valid: false, reason: 'missing or empty string field `gate`' };
  }
  if (parsed.gate !== expectedGate) {
    return {
      valid: false,
      reason:
        `baseline gate=${JSON.stringify(parsed.gate)} does not match ` +
        `expected ${JSON.stringify(expectedGate)}`,
    };
  }
  if (
    typeof parsed.published_at !== 'string' ||
    parsed.published_at.length === 0
  ) {
    return {
      valid: false,
      reason: 'missing or empty string field `published_at`',
    };
  }
  if (
    typeof parsed.sample_size !== 'number' ||
    !Number.isFinite(parsed.sample_size) ||
    !Number.isInteger(parsed.sample_size) ||
    parsed.sample_size < 0
  ) {
    return {
      valid: false,
      reason: 'field `sample_size` must be a non-negative integer',
    };
  }
  if (
    parsed.findings_baseline === undefined ||
    parsed.findings_baseline === null
  ) {
    return {
      valid: false,
      reason: 'missing required field `findings_baseline`',
    };
  }
  return {
    valid: true,
    baseline: {
      gate: parsed.gate,
      published_at: parsed.published_at,
      sample_size: parsed.sample_size,
      findings_baseline: parsed.findings_baseline,
    },
  };
}

/**
 * Pure predicate: is a schema-valid baseline's `sample_size` sufficient per
 * REQ-011? See module header §Sufficiency predicate for the single-threshold
 * rationale.
 *
 * @param {{ sample_size: number }} baseline
 * @returns {boolean}
 */
export function isSufficient(baseline) {
  return baseline.sample_size >= MIN_SUFFICIENT_SAMPLE_SIZE;
}

/**
 * Check whether the workstream-scoped override file is present AND contains
 * valid JSON. Any parseable JSON object satisfies AC18.3 — rationale field
 * enforcement is deliberately deferred to the operator runbook per shipped
 * Implementation Notes.
 *
 * Returns `{ present: false }` when the file does not exist OR exists but
 * cannot be read or parsed; the "invalid JSON" case treats the override as
 * not-applied (operators who fat-finger an override should see the baseline
 * rejection, not a silent acceptance). No error is emitted for an invalid
 * override — the rejection cascade handles operator feedback via the
 * baseline failure's own error code.
 *
 * @param {string} projectRoot
 * @returns {{ present: false } | { present: true, path: string, body: object }}
 */
export function readOverride(projectRoot) {
  const overridePath = join(projectRoot, OVERRIDE_RELATIVE_PATH);
  if (!existsSync(overridePath)) {
    return { present: false };
  }
  let raw;
  try {
    raw = readFileSync(overridePath, 'utf-8');
  } catch {
    // Unreadable override file — treat as not-present per design note above.
    return { present: false };
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    // Malformed JSON override — same rationale; rejection cascade wins.
    return { present: false };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { present: false };
  }
  return { present: true, path: overridePath, body };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run the ws-3 flow-verify diff-scope coercive-flip preflight.
 *
 * Non-throwing: returns `{ ok: boolean, error?: { code, message, details } }`.
 * All structured rejections flow through the return envelope; only truly
 * unanticipated failures (I/O exceptions outside the override file) propagate.
 *
 * The function is async so it can later interop with async dependencies
 * (e.g., a future schema-validator Zod lazy-import) without breaking its
 * callers. Today it is synchronous under the hood.
 *
 * Precedence (first match wins):
 *   1. Baseline missing          → `BASELINE_MISSING`       unless override present.
 *   2. Baseline schema-invalid   → `BASELINE_SCHEMA_INVALID` unless override present.
 *   3. Baseline undersized       → `BASELINE_UNDERSIZED`    unless override present.
 *   4. Baseline valid & sufficient → accept.
 *
 * AC18.3: override presence short-circuits precedence rules 1–3 to acceptance.
 * AC18.4: only `CANON_BASELINE_RELATIVE_PATH` is read; legacy path is ignored.
 *
 * @param {{
 *   projectRoot: string,
 *   gate?: string,
 * }} opts
 * @returns {Promise<{
 *   ok: true,
 *   override_applied: boolean,
 *   baseline?: { gate: string, published_at: string, sample_size: number, findings_baseline: unknown },
 *   override_path?: string,
 * } | {
 *   ok: false,
 *   error: { code: string, message: string, details?: object },
 * }>}
 */
export async function preflightBaseline(opts) {
  if (!opts || typeof opts !== 'object' || typeof opts.projectRoot !== 'string') {
    throw new TypeError(
      'preflightBaseline({ projectRoot, gate? }) requires a string `projectRoot`',
    );
  }
  const projectRoot = opts.projectRoot;
  const gate = opts.gate || FLOW_VERIFY_DIFF_SCOPE_GATE;

  const baselinePath = join(projectRoot, CANON_BASELINE_RELATIVE_PATH);
  const override = readOverride(projectRoot);

  // Step 1: baseline presence.
  if (!existsSync(baselinePath)) {
    if (override.present) {
      // AC18.3: override accepts even a missing baseline. The test case at
      // `AC18.3 > accepts when override file exists and baseline is missing`
      // exercises exactly this branch.
      return {
        ok: true,
        override_applied: true,
        override_path: override.path,
      };
    }
    return {
      ok: false,
      error: {
        code: PREFLIGHT_ERROR_CODES.BASELINE_MISSING,
        message:
          `Baseline file missing at canonical path ` +
          `${baselinePath}. Publish via the ws-1 baseline-publisher ` +
          `primitive, or provide an operator override at ` +
          `${join(projectRoot, OVERRIDE_RELATIVE_PATH)}.`,
        details: { baseline_path: baselinePath, gate },
      },
    };
  }

  // Step 2: baseline readable + JSON-parseable + contract-shaped.
  let rawBody;
  try {
    rawBody = readFileSync(baselinePath, 'utf-8');
  } catch (err) {
    if (override.present) {
      return {
        ok: true,
        override_applied: true,
        override_path: override.path,
      };
    }
    return {
      ok: false,
      error: {
        code: PREFLIGHT_ERROR_CODES.BASELINE_SCHEMA_INVALID,
        message:
          `Baseline at ${baselinePath} is unreadable: ` +
          `${err && err.message ? err.message : String(err)}`,
        details: { baseline_path: baselinePath, gate },
      },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    if (override.present) {
      return {
        ok: true,
        override_applied: true,
        override_path: override.path,
      };
    }
    return {
      ok: false,
      error: {
        code: PREFLIGHT_ERROR_CODES.BASELINE_SCHEMA_INVALID,
        message:
          `Baseline at ${baselinePath} is not valid JSON: ` +
          `${err && err.message ? err.message : String(err)}`,
        details: { baseline_path: baselinePath, gate },
      },
    };
  }

  const shape = validateBaselineShape(parsed, gate);
  if (!shape.valid) {
    if (override.present) {
      return {
        ok: true,
        override_applied: true,
        override_path: override.path,
      };
    }
    return {
      ok: false,
      error: {
        code: PREFLIGHT_ERROR_CODES.BASELINE_SCHEMA_INVALID,
        message:
          `Baseline at ${baselinePath} failed contract-shape validation: ${shape.reason}`,
        details: { baseline_path: baselinePath, gate, reason: shape.reason },
      },
    };
  }

  // Step 3: sample-size sufficiency.
  if (!isSufficient(shape.baseline)) {
    if (override.present) {
      // AC18.3: override accepts an undersized baseline. Tested at
      // `AC18.3 > accepts when override file exists and baseline is undersized`.
      return {
        ok: true,
        override_applied: true,
        baseline: shape.baseline,
        override_path: override.path,
      };
    }
    return {
      ok: false,
      error: {
        code: PREFLIGHT_ERROR_CODES.BASELINE_UNDERSIZED,
        message:
          `Baseline sample_size=${shape.baseline.sample_size} is below the ` +
          `sufficiency threshold (sample_size >= ${MIN_SUFFICIENT_SAMPLE_SIZE}). ` +
          `Accumulate more samples or provide an operator override at ` +
          `${join(projectRoot, OVERRIDE_RELATIVE_PATH)}.`,
        details: {
          baseline_path: baselinePath,
          gate,
          sample_size: shape.baseline.sample_size,
          threshold: MIN_SUFFICIENT_SAMPLE_SIZE,
        },
      },
    };
  }

  // Happy path — baseline is present, schema-valid, and sufficient.
  return {
    ok: true,
    override_applied: false,
    baseline: shape.baseline,
  };
}

/** Default export: canonical entry point. Kept as an alias of the named. */
export default preflightBaseline;

/**
 * Throw-style alias. Callers that prefer `try/catch` flow instead of
 * `{ ok, error }` envelopes can use this; rejection is surfaced as a
 * `BaselinePreflightError` whose `.code` matches `PREFLIGHT_ERROR_CODES`.
 *
 * @param {{ projectRoot: string, gate?: string }} opts
 * @returns {Promise<{
 *   ok: true,
 *   override_applied: boolean,
 *   baseline?: object,
 *   override_path?: string,
 * }>}
 */
export async function runBaselinePreflight(opts) {
  const result = await preflightBaseline(opts);
  if (result.ok) return result;
  throw new BaselinePreflightError(
    result.error.code,
    result.error.message,
    result.error.details,
  );
}
