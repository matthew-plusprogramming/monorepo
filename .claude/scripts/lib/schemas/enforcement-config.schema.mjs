/**
 * Pipeline-Efficiency Enforcement Config Schema
 *
 * Validates the enforcement-flag config file at
 * `.claude/config/pipeline-efficiency-enforcement.json` per spec
 * `sg-pipeline-efficiency-ws1-convergence-pruning` §Enforcement config schema
 * (spec.md:630-639). The file is operator-only (write-protected via
 * `workflow-file-protection.mjs` FULL_BLOCK basename list; bootstrap via
 * `git commit -S` under EDGE-019 carve-out) -- agents read only.
 *
 * Two schemas are exported:
 *   - enforcementConfigSchema       -- full config with mode ∈ {advisory, coercive, off}
 *   - sessionOverrideSchema         -- narrowed variant for session-scoped overrides;
 *                                      mode ∈ {advisory, coercive} (off rejected, REQ-013)
 *
 * Validation lives at boundaries:
 *   - Config-file reader (as-021 / as-E2 `pipeline-efficiency-enforcement-reader.mjs`)
 *   - Session-override flip handler
 *
 * Implements: AC3.1, AC3.2, AC3.5
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning
 * Parent task: Phase A — Task A3
 */

// =============================================================================
// Shared primitives
// =============================================================================

/**
 * ISO-8601 UTC timestamp string.
 *
 * Accepts both second-precision (`YYYY-MM-DDTHH:MM:SSZ`) and sub-second
 * precision (`YYYY-MM-DDTHH:MM:SS.sssZ`). The trailing `Z` is required --
 * offset forms (`+00:00`) are rejected to keep audit timestamps canonical.
 *
 * Mirrors the pattern in `.claude/scripts/lib/silent-drop-schemas.mjs`
 * (iso8601UtcSchema) so the project has one canonical ISO-8601 shape.
 */
const ISO8601_UTC_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function makeValidationError(issues) {
  const message = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  const error = new Error(message || 'validation failed');
  error.name = 'ValidationError';
  error.issues = issues;
  return error;
}

function makeSuccess(data) {
  return { success: true, data };
}

function makeFailure(issues) {
  return { success: false, error: makeValidationError(issues) };
}

function makeStringRegexSchema(regex, message) {
  return Object.freeze({
    safeParse(value) {
      if (typeof value === 'string' && regex.test(value)) {
        return makeSuccess(value);
      }
      return makeFailure([{ path: [], message }]);
    },
    parse(value) {
      const result = this.safeParse(value);
      if (!result.success) throw result.error;
      return result.data;
    },
  });
}

function makeEnumSchema(values) {
  const valueSet = new Set(values);
  const enumObject = Object.fromEntries(values.map((value) => [value, value]));
  return Object.freeze({
    options: Object.freeze([...values]),
    enum: Object.freeze(enumObject),
    safeParse(value) {
      if (valueSet.has(value)) {
        return makeSuccess(value);
      }
      return makeFailure([
        {
          path: [],
          message: `expected one of: ${values.join(', ')}`,
        },
      ]);
    },
    parse(value) {
      const result = this.safeParse(value);
      if (!result.success) throw result.error;
      return result.data;
    },
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateNonEmptyString(value, path, issues) {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push({ path, message: 'expected non-empty string' });
  }
}

function validateConfigShape(raw, modeSchema) {
  if (!isPlainObject(raw)) {
    return makeFailure([{ path: [], message: 'expected object' }]);
  }

  const issues = [];
  const allowedKeys = new Set(['mode', 'effective_at', 'operator', 'substrate']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      issues.push({ path: [key], message: 'unknown key' });
    }
  }

  const modeResult = modeSchema.safeParse(raw.mode);
  if (!modeResult.success) {
    issues.push({
      path: ['mode'],
      message: modeResult.error.message,
    });
  }

  const effectiveAtResult = iso8601UtcSchema.safeParse(raw.effective_at);
  if (!effectiveAtResult.success) {
    issues.push({
      path: ['effective_at'],
      message: 'must be ISO-8601 UTC (Z suffix)',
    });
  }

  validateNonEmptyString(raw.operator, ['operator'], issues);
  validateNonEmptyString(raw.substrate, ['substrate'], issues);

  if (issues.length > 0) {
    return makeFailure(issues);
  }

  return makeSuccess({
    mode: raw.mode,
    effective_at: raw.effective_at,
    operator: raw.operator,
    substrate: raw.substrate,
  });
}

export const iso8601UtcSchema = makeStringRegexSchema(
  ISO8601_UTC_REGEX,
  'must be ISO-8601 UTC (Z suffix)'
);

// =============================================================================
// Mode enums
// =============================================================================

/** Full three-mode enum for the on-disk config file (REQ-013). */
export const ENFORCEMENT_MODES = ['advisory', 'coercive', 'off'];

/** Enum: mode in {advisory, coercive, off}. */
export const enforcementModeSchema = makeEnumSchema([
  'advisory',
  'coercive',
  'off',
]);

/**
 * Session-override narrowed enum: mode ∈ {advisory, coercive}.
 *
 * REQ-013: session-scoped override MUST reject `off` -- only the on-disk
 * config (written by signed commit) may set `off`. This prevents a session
 * from silently disabling enforcement without a signed-commit audit trail.
 */
export const sessionOverrideModeSchema = makeEnumSchema([
  'advisory',
  'coercive',
]);

// =============================================================================
// Enforcement config schema (on-disk file shape)
// =============================================================================

/**
 * EnforcementConfig -- `.claude/config/pipeline-efficiency-enforcement.json`.
 *
 * Per REQ-013 (spec.md:169) and contract-enforcement-primitives (spec.md:549-553).
 *
 * Fields:
 *   - mode         -- current enforcement mode (advisory | coercive | off)
 *   - effective_at -- ISO-8601 UTC timestamp the mode took effect
 *   - operator     -- signed-commit identity of the operator who set the mode
 *   - substrate    -- deployment substrate (e.g., "local-single-maintainer")
 *
 * `.strict()` rejects unknown keys to prevent silent schema drift.
 */
export const enforcementConfigSchema = Object.freeze({
  safeParse(raw) {
    return validateConfigShape(raw, enforcementModeSchema);
  },
  parse(raw) {
    const result = this.safeParse(raw);
    if (!result.success) throw result.error;
    return result.data;
  },
});

// =============================================================================
// Session-override schema (narrowed variant)
// =============================================================================

/**
 * SessionOverrideConfig -- narrowed variant for session-scoped mode overrides.
 *
 * Shape mirrors `enforcementConfigSchema` but with `mode` narrowed to
 * `{advisory, coercive}` per REQ-013 (session override MUST NOT set `off`).
 *
 * Consumers applying a session override MUST validate the incoming override
 * object against this schema; a request to set `mode: "off"` will be rejected
 * at the boundary (AC3.5).
 */
export const sessionOverrideSchema = Object.freeze({
  safeParse(raw) {
    return validateConfigShape(raw, sessionOverrideModeSchema);
  },
  parse(raw) {
    const result = this.safeParse(raw);
    if (!result.success) throw result.error;
    return result.data;
  },
});

// =============================================================================
// Type exports for JSDoc / consumer ergonomics
// =============================================================================

/** @typedef {{mode: 'advisory' | 'coercive' | 'off', effective_at: string, operator: string, substrate: string}} EnforcementConfig */
/** @typedef {{mode: 'advisory' | 'coercive', effective_at: string, operator: string, substrate: string}} SessionOverrideConfig */
/** @typedef {'advisory' | 'coercive' | 'off'} EnforcementMode */
/** @typedef {'advisory' | 'coercive'} SessionOverrideMode */
