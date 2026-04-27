/**
 * EnforcementFlag Zod schema + parseFlag helper.
 *
 * Spec: sg-e2e-enforcement-flag-audit as-001 / parent spec.md
 *       §Interfaces-&-Contracts (EnforcementFlag data-model)
 * Requirements: REQ-NFR-015 (enforcement-flag contract), SEC-016 (past-bound
 *   backdating resistance — effective_at >= now - 5min).
 *
 * Schema shape (strict — rejects unknown keys per AC1.6):
 *   {
 *     mode: "advisory" | "coercive" | "off",
 *     effective_at: ISO-8601 datetime string,
 *     operator: non-empty string,
 *   }
 *
 * Bounds on effective_at:
 *   - past-bound  >= now() - 5 min   (SEC-016)
 *   - future-bound <= now() + 30 days
 *
 * parseFlag discriminates two error shapes:
 *   - FLAG_FILE_MALFORMED  — JSON.parse threw; issues: []
 *   - FLAG_VALIDATION_FAILED — Zod schema rejected; issues: Zod issue array
 */

import { z } from 'zod';

const MODE_ENUM = ['advisory', 'coercive', 'off'];

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Build the EnforcementFlag schema parameterized by a caller-supplied `now`.
 *
 * The Zod refine closure captures `now` so bound checks are deterministic for
 * tests (no reliance on wall-clock). `parseFlag` exposes this indirection
 * through its `now` parameter.
 *
 * @param {Date} now
 */
function buildSchema(now) {
  return z
    .object({
      mode: z.enum(MODE_ENUM),
      effective_at: z.string().datetime({ offset: true }),
      operator: z.string().min(1),
    })
    .strict()
    .superRefine((value, ctx) => {
      const effective = new Date(value.effective_at).getTime();
      const nowMs = now.getTime();
      const pastBound = nowMs - FIVE_MINUTES_MS;
      const futureBound = nowMs + THIRTY_DAYS_MS;
      if (effective < pastBound) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['effective_at'],
          message:
            'effective_at must be >= now - 5min (SEC-016 backdating resistance)',
        });
      }
      if (effective > futureBound) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['effective_at'],
          message: 'effective_at must be <= now + 30 days (future-bound)',
        });
      }
    });
}

/**
 * Structural-only schema (no time-bound refinement). Used by callers that
 * validate ALREADY-WRITTEN flag bytes — at read time the past/future bounds
 * are irrelevant because the bounds are a WRITE-TIME constraint (operator
 * cannot forge past effective_at). Keeping read-time validation
 * bound-agnostic means an existing flag stays readable after its
 * effective_at has aged past the 5-minute past-bound relative to wall-clock.
 */
const structuralSchema = z
  .object({
    mode: z.enum(MODE_ENUM),
    effective_at: z.string().datetime({ offset: true }),
    operator: z.string().min(1),
  })
  .strict();

/**
 * Surface schema for schema-introspection callers (exposes `.safeParse`).
 *
 * Bound-check uses the wall-clock at call time; for deterministic tests use
 * `parseFlag(jsonString, now)` which injects `now` into a rebuilt schema.
 */
export const EnforcementFlagSchema = buildSchema(new Date());

/**
 * Parse flag JSON bytes for STRUCTURAL validity only (no past/future bound).
 *
 * Used by the read-time resolver — bounds are a write-time constraint, so
 * re-applying them when reading a persisted flag is incorrect. The resolver
 * is responsible for clock-skew reporting (non-blocking).
 *
 * Same error-code taxonomy as `parseFlag`: FLAG_FILE_MALFORMED / FLAG_VALIDATION_FAILED.
 *
 * @param {string} jsonString
 * @returns {{success: true, data: {mode: string, effective_at: string, operator: string}}
 *           | {success: false, error: {code: string, message: string, issues: any[]}}}
 */
export function parseFlagStructural(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'FLAG_FILE_MALFORMED',
        message: `Flag file JSON parse failure: ${err instanceof Error ? err.message : String(err)}`,
        issues: [],
      },
    };
  }

  const result = structuralSchema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: {
      code: 'FLAG_VALIDATION_FAILED',
      message: 'Flag file schema validation failed',
      issues: result.error.issues,
    },
  };
}

/**
 * Parse + validate a flag file's JSON bytes.
 *
 * Returns a discriminated result:
 *   - {success: true, data} when JSON parses AND schema validates
 *   - {success: false, error: {code: "FLAG_FILE_MALFORMED", message, issues: []}}
 *       when JSON.parse throws (AC1.7)
 *   - {success: false, error: {code: "FLAG_VALIDATION_FAILED", message, issues: ZodIssue[]}}
 *       when Zod rejects (AC1.2, AC1.3, AC1.4, AC1.5, AC1.6)
 *
 * @param {string} jsonString - Raw file bytes / string.
 * @param {Date} [now=new Date()] - Injected wall-clock for deterministic tests.
 * @returns {{success: true, data: {mode: string, effective_at: string, operator: string}}
 *           | {success: false, error: {code: string, message: string, issues: any[]}}}
 */
export function parseFlag(jsonString, now = new Date()) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'FLAG_FILE_MALFORMED',
        message: `Flag file JSON parse failure: ${err instanceof Error ? err.message : String(err)}`,
        issues: [],
      },
    };
  }

  const schema = buildSchema(now);
  const result = schema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: {
      code: 'FLAG_VALIDATION_FAILED',
      message: 'Flag file schema validation failed',
      issues: result.error.issues,
    },
  };
}
