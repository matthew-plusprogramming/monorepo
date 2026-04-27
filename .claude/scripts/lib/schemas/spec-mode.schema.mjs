/**
 * SpecManifestModeField — Practice 2.4 bug-fix-mode positive signal.
 *
 * Spec: sg-pipeline-efficiency-ws2-practice-2.4
 * Atomic: as-001-spec-mode-manifest-field
 * Implements: AC1.1, AC1.2, AC1.3 (validator surface);
 *             AC-005.1, AC-005.2 (parent spec — positive signal + fail-closed default).
 * Parent contract: spec.md §Interfaces & Contracts (SpecManifestModeField data-model).
 *
 * Purpose
 *   Positive, non-heuristic signal that distinguishes bug-fix workstreams from
 *   feature workstreams. Downstream consumers (test-writer isolation hook,
 *   `record-test-writer-unlock` CLI preflight) branch on this field.
 *
 * Canonical default semantics (fail-closed)
 *   - Absent `spec_mode`            → "feature" (strict isolation)
 *   - `spec_mode === "feature"`     → strict isolation
 *   - `spec_mode === "bug-fix"`     → hybrid-mode eligibility (unlock permitted)
 *   - `spec_mode === "refactor"`    → strict isolation (reserved future; treated as non-bug-fix)
 *   - Any other value               → rejected by validator (AC1.3)
 *
 * Two exports on purpose
 *   - `specModeEnum`        — raw enum (3 values) without default; use when a
 *                             consumer wants strict membership test on an already-
 *                             normalized value (e.g., CLI preflight comparing to
 *                             "bug-fix" after normalization).
 *   - `specModeSchema`      — enum + `.default("feature")`; use at boundary
 *                             parse sites where the absent-field case must
 *                             normalize to "feature" in the returned object
 *                             (AC1.2).
 *
 * Consumers (current + imminent)
 *   - `.claude/scripts/validate-manifest.mjs` — AC1.1/AC1.2/AC1.3 at manifest
 *     validation time. Surfaces the normalized value back to callers via
 *     `normalizeSpecMode`.
 *   - `.claude/scripts/session-checkpoint.mjs record-test-writer-unlock` (as-003)
 *     — preflight rejects with UNLOCK_MODE_MISMATCH unless normalized
 *     `spec_mode === "bug-fix"` (AC-005.7).
 *   - PreToolUse test-writer isolation hook (as-006) — fail-closed-default read
 *     path uses `normalizeSpecMode` before checking any unlock state.
 *
 * Boundary validation rule
 *   Validation is performed at the point where a manifest enters an in-memory
 *   representation for a downstream decision. The JSON-Schema validator
 *   (`validate-manifest.mjs`) is the primary contract-time gate; this Zod
 *   schema is the runtime-consumer gate for code paths that load the manifest
 *   without going through the file validator (e.g., session-checkpoint during
 *   CLI preflight).
 */

import { z } from 'zod';

// =============================================================================
// Constants
// =============================================================================

/**
 * Canonical enum values (spec §Interfaces & Contracts — SpecManifestModeField).
 * Frozen so downstream imports cannot mutate the set.
 *
 * @type {ReadonlyArray<'feature' | 'bug-fix' | 'refactor'>}
 */
export const SPEC_MODE_VALUES = Object.freeze(['feature', 'bug-fix', 'refactor']);

/**
 * The canonical fail-closed default. Any absent, `null`, or `undefined`
 * `spec_mode` normalizes to this value — which denies hybrid-mode eligibility
 * (per AC-005.2). Kept as a named constant so downstream consumers can compare
 * against it without re-declaring the literal.
 *
 * @type {'feature'}
 */
export const SPEC_MODE_DEFAULT = 'feature';

/**
 * The single value that activates hybrid-mode eligibility (Practice 2.4
 * bug-fix hybrid flow — spec §Flow 2). Exported as a named constant so
 * downstream consumers (CLI preflight, PreToolUse hook) do not sprinkle the
 * literal.
 *
 * @type {'bug-fix'}
 */
export const SPEC_MODE_BUG_FIX = 'bug-fix';

// =============================================================================
// Schemas
// =============================================================================

/**
 * Raw 3-value enum without default. Use when the input has already been
 * normalized (absent → default applied elsewhere) and you want a strict
 * membership check.
 *
 * Rejects any value not in `SPEC_MODE_VALUES` with a structured Zod
 * `invalid_enum_value` error citing the allowed values (AC1.3).
 */
export const specModeEnum = z.enum(['feature', 'bug-fix', 'refactor']);

/**
 * Enum + default. Use at a boundary where the input may lack the field: the
 * Zod `.default("feature")` transformation normalizes `undefined` to
 * `"feature"` in the parsed object (AC1.2). `null` is explicitly NOT coerced
 * — callers passing `null` indicate an explicit value and Zod will reject
 * with `invalid_type` by design.
 *
 * Field name on manifest: `spec_mode`. Schema name keeps the `specMode`
 * camelCase idiom used elsewhere in lib/schemas/.
 */
export const specModeSchema = specModeEnum.default(SPEC_MODE_DEFAULT);

// =============================================================================
// Normalization helper (surface used by validate-manifest.mjs + CLI preflight)
// =============================================================================

/**
 * Normalize the `spec_mode` field on a parsed manifest object to the canonical
 * value the validator + downstream consumers expect.
 *
 * Rules (in order):
 *   1. If `input` is not an object → return a structured error result.
 *   2. If `spec_mode` is absent (`undefined` or property missing)
 *      → set to `SPEC_MODE_DEFAULT` and return `{ ok: true, value: 'feature', applied_default: true }`.
 *   3. If `spec_mode` is a member of `SPEC_MODE_VALUES`
 *      → return `{ ok: true, value, applied_default: false }`.
 *   4. Any other value (null, non-string, string outside enum)
 *      → return `{ ok: false, error: { field, allowed, observed } }` without mutating input.
 *
 * Mutation semantics
 *   Rule 2 DOES mutate the caller's object — it writes `spec_mode` in place.
 *   This aligns with `validate-manifest.mjs` conventions (callers already own
 *   the parsed object and expect the validator to leave it in normalized
 *   shape). Callers that need the pre-normalization snapshot should clone
 *   before invocation.
 *
 * @param {unknown} input — parsed manifest object (must be non-null object).
 * @returns {
 *   | { ok: true, value: 'feature' | 'bug-fix' | 'refactor', applied_default: boolean }
 *   | { ok: false, error: { field: 'spec_mode', allowed: readonly string[], observed: unknown } }
 * }
 */
export function normalizeSpecMode(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        field: 'spec_mode',
        allowed: SPEC_MODE_VALUES,
        observed: input,
      },
    };
  }

  const current = /** @type {Record<string, unknown>} */ (input).spec_mode;

  // Rule 2: absent → apply default in place.
  if (current === undefined) {
    /** @type {any} */ (input).spec_mode = SPEC_MODE_DEFAULT;
    return { ok: true, value: SPEC_MODE_DEFAULT, applied_default: true };
  }

  // Rule 3: present + valid → pass through.
  if (typeof current === 'string' && SPEC_MODE_VALUES.includes(/** @type {any} */ (current))) {
    return {
      ok: true,
      value: /** @type {'feature' | 'bug-fix' | 'refactor'} */ (current),
      applied_default: false,
    };
  }

  // Rule 4: present + invalid → structured rejection, no mutation.
  return {
    ok: false,
    error: {
      field: 'spec_mode',
      allowed: SPEC_MODE_VALUES,
      observed: current,
    },
  };
}

/**
 * Predicate form of the hybrid-eligibility gate. Thin wrapper around
 * `normalizeSpecMode` that returns a boolean instead of a structured result.
 *
 * Semantics (fail-closed — AC-005.2):
 *   - absent / feature / refactor / invalid → `false`
 *   - bug-fix                                → `true`
 *
 * Invalid values return `false` here (not a throw) because this is the
 * "gate" predicate — the call site is already past the validator and is
 * asking a yes/no eligibility question. Validator-layer rejections belong to
 * `normalizeSpecMode` return shape, not this predicate.
 *
 * @param {unknown} input — parsed manifest object.
 * @returns {boolean}
 */
export function isBugFixMode(input) {
  const result = normalizeSpecMode(input);
  return result.ok && result.value === SPEC_MODE_BUG_FIX;
}

// =============================================================================
// Type exports (JSDoc for consumer ergonomics)
// =============================================================================

/** @typedef {z.infer<typeof specModeEnum>} SpecMode */
/** @typedef {z.infer<typeof specModeSchema>} SpecModeWithDefault */
