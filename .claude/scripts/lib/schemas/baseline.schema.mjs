/**
 * Baseline + baseline-override Zod schemas (Phase A — as-004).
 *
 * Per-gate baseline files and per-workstream override files feed the
 * coercive-flip preflight (as-025), the metrics publisher (as-029), and the
 * 3-way baseline gate in completion-verifier (REQ-017 / EC-9). This module
 * defines the Zod schemas plus the pure sample-size sufficiency predicate
 * `isSufficientBaseline(baseline)` consumed at preflight time to reject
 * undersized baselines (REQ-011).
 *
 * Canonical paths (authoritative — do NOT inline elsewhere):
 *   - per-gate baseline:         .claude/metrics/pipeline-efficiency-<gate>-baseline.json
 *   - per-workstream override:   .claude/metrics/<workstream-id>-baseline-override.json
 *
 * Contract shape (spec.md §contract-enforcement-primitives.baselines, L573-578):
 *   baseline = {
 *     gate_name,                  // canonical gate identifier
 *     false_positive_rate,        // [0..1]
 *     catch_rate,                 // [0..1]
 *     sample_count,               // >= 0 integer (≥10 OR window ≥30d for sufficiency)
 *     measurement_window_start,   // ISO-8601
 *     measurement_window_end,     // ISO-8601
 *     published_at,               // ISO-8601
 *     operator                    // git-signer identity
 *   }
 *   override = {
 *     workstream_id,              // e.g., "ws-1"
 *     rationale,                  // required; missing → reject (AC4.4)
 *     operator,                   // git-signer identity
 *     effective_at                // ISO-8601
 *   }
 *
 * Deployment: schema-only landing. No runtime reads until as-025 (preflight) /
 * as-026 (publisher) / as-029 (metrics publisher) ship.
 *
 * @req REQ-011
 * @spec sg-pipeline-efficiency-ws1-convergence-pruning as-004
 */

import { z } from 'zod';

// =============================================================================
// Sufficiency thresholds (REQ-011: ≥10 workstreams OR ≥30 days)
// =============================================================================

/** Minimum sample_count that by itself satisfies sufficiency (REQ-011). */
export const MIN_SAMPLE_COUNT = 10;

/** Minimum measurement-window span in days that by itself satisfies sufficiency. */
export const MIN_WINDOW_DAYS = 30;

/** Milliseconds per day — used for pure, clock-free window-span math. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// =============================================================================
// ISO-8601 validation
// =============================================================================

/**
 * Strict ISO-8601 pattern matching the project convention in
 * `test-baseline-schema.mjs` (`new Date(v).toISOString()` shape). Accepts the
 * `Z` suffix as well as explicit `+HH:MM` / `-HH:MM` offsets.
 */
export const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * ISO-8601 predicate used by Zod `.refine()` hooks.
 *
 * Gates by regex first (rejects locale-shaped strings that `Date` would accept),
 * then confirms the parsed instant is real (rejects `2026-02-30T00:00:00Z`).
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isIso8601(v) {
  return (
    typeof v === 'string' && ISO_8601_RE.test(v) && !Number.isNaN(new Date(v).getTime())
  );
}

/** Zod field builder for required ISO-8601 timestamp strings. */
const isoTimestamp = (fieldName) =>
  z
    .string()
    .min(1, `${fieldName} is required`)
    .refine(isIso8601, { message: `${fieldName} must be a valid ISO-8601 timestamp` });

// =============================================================================
// Baseline schema (AC4.1)
// =============================================================================

/**
 * Per-gate baseline file shape. Contract fields are REQUIRED; no optional
 * fields until a spec amendment extends the contract.
 *
 * AC4.1: a well-formed baseline with all 8 fields SHALL be accepted.
 * AC4.1 (implicit): rates are in [0..1]; `sample_count` is a non-negative integer.
 *
 * `.strict()` is intentional — an unknown field on a baseline indicates schema
 * drift and must fail validation before the preflight reads it.
 */
export const baselineSchema = z
  .object({
    gate_name: z.string().min(1, 'gate_name is required'),
    false_positive_rate: z
      .number()
      .min(0, 'false_positive_rate must be >= 0')
      .max(1, 'false_positive_rate must be <= 1'),
    catch_rate: z
      .number()
      .min(0, 'catch_rate must be >= 0')
      .max(1, 'catch_rate must be <= 1'),
    sample_count: z
      .number()
      .int('sample_count must be an integer')
      .nonnegative('sample_count must be >= 0'),
    measurement_window_start: isoTimestamp('measurement_window_start'),
    measurement_window_end: isoTimestamp('measurement_window_end'),
    published_at: isoTimestamp('published_at'),
    operator: z.string().min(1, 'operator is required'),
  })
  .strict()
  .refine(
    (b) => new Date(b.measurement_window_end).getTime() >= new Date(b.measurement_window_start).getTime(),
    {
      message: 'measurement_window_end must be >= measurement_window_start',
      path: ['measurement_window_end'],
    },
  );

// =============================================================================
// Override schema (AC4.4)
// =============================================================================

/**
 * Per-workstream override shape. `rationale` is REQUIRED — AC4.4 explicitly
 * rejects overrides lacking rationale.
 *
 * Override scope is a single workstream (`workstream_id`); no cross-workstream
 * propagation per spec.md §contract-enforcement-primitives.baselines.override_scope.
 *
 * `.strict()` prevents silent extra fields from shadowing operator intent.
 */
export const baselineOverrideSchema = z
  .object({
    workstream_id: z.string().min(1, 'workstream_id is required'),
    rationale: z.string().min(1, 'rationale is required'),
    operator: z.string().min(1, 'operator is required'),
    effective_at: isoTimestamp('effective_at'),
  })
  .strict();

// =============================================================================
// Sample-size sufficiency predicate (AC4.2, AC4.3)
// =============================================================================

/**
 * Pure predicate: is this baseline sufficient to permit an advisory → coercive
 * flip?
 *
 * AC4.2: sample_count < 10 AND window span < 30 days → false.
 * AC4.3: sample_count >= 10 OR window span >= 30 days → true.
 *
 * Runs `baselineSchema.safeParse` first so a malformed baseline is treated as
 * insufficient rather than throwing at the preflight call site. Preflight
 * callers that need structured schema errors should call `baselineSchema.parse`
 * directly; this predicate is boolean by design.
 *
 * Window span is computed in whole days via `Math.floor` on the ms difference
 * — clock-free and timezone-free because both endpoints are ISO-8601 UTC
 * instants by schema contract.
 *
 * @param {unknown} baseline
 * @returns {boolean}
 */
export function isSufficientBaseline(baseline) {
  const parsed = baselineSchema.safeParse(baseline);
  if (!parsed.success) return false;

  const { sample_count, measurement_window_start, measurement_window_end } = parsed.data;

  if (sample_count >= MIN_SAMPLE_COUNT) return true;

  const startMs = new Date(measurement_window_start).getTime();
  const endMs = new Date(measurement_window_end).getTime();
  const spanDays = Math.floor((endMs - startMs) / MS_PER_DAY);

  return spanDays >= MIN_WINDOW_DAYS;
}

// =============================================================================
// Structured-error helper (for downstream consumers that want Zod issue lists)
// =============================================================================

/**
 * Error subclass for fail-closed parse failures — mirrors
 * `TestBaselineError` from `test-baseline-schema.mjs` so downstream callers
 * can branch on `kind` without string-matching.
 */
export class BaselineSchemaError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'BaselineSchemaError';
    this.kind = kind;
  }
}

/**
 * Validate a baseline, throwing on failure. Convenience wrapper for call sites
 * that want an assertion-style API (as-025 preflight, as-029 publisher).
 *
 * @param {unknown} input
 * @param {object} [opts]
 * @param {string} [opts.sourceLabel]
 * @returns {z.infer<typeof baselineSchema>}
 */
export function validateBaseline(input, opts = {}) {
  const label = opts.sourceLabel || 'baseline';
  const result = baselineSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new BaselineSchemaError(`${label}: schema violation — ${issues}`, 'schema_violation');
  }
  return result.data;
}

/**
 * Validate a baseline-override, throwing on failure.
 *
 * @param {unknown} input
 * @param {object} [opts]
 * @param {string} [opts.sourceLabel]
 * @returns {z.infer<typeof baselineOverrideSchema>}
 */
export function validateBaselineOverride(input, opts = {}) {
  const label = opts.sourceLabel || 'baseline-override';
  const result = baselineOverrideSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new BaselineSchemaError(`${label}: schema violation — ${issues}`, 'schema_violation');
  }
  return result.data;
}
