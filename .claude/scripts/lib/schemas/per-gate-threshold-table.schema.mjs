/**
 * PerGateThresholdTable schema
 *
 * Validates the per-gate convergence threshold table shape per the Phase A
 * Data Model Contract (contract-per-gate-threshold-table).
 *
 * The table is the single source of truth for per-gate convergence thresholds,
 * attestation modes, and hash-input manifests. It replaces the hardcoded
 * `REQUIRED_CLEAN_PASSES = 2` at workflow-dag.mjs:273 (preserved during Phase A
 * for behavior continuity; consumers migrate in as-008..as-015).
 *
 * Contract shape (verbatim from spec.md §Phase A):
 *   PerGateThresholdTable = {
 *     [gate_name]: {
 *       required_clean_passes: number,
 *       attestation_mode: "content-hash" | "timestamp" | "none",
 *       hash_input_manifest: string[],
 *       rationale?: string  // mandatory when attestation_mode === "none"
 *     }
 *   }
 *
 * Validation rules (AC2.1..AC2.4, AC2.6):
 *   - required_clean_passes: positive integer (floor validator in Phase D
 *     enforces >= 1 at runtime against env overrides; the schema itself
 *     accepts any positive int).
 *   - attestation_mode: enum of the three canonical modes.
 *   - hash_input_manifest: string array (may be empty when attestation_mode
 *     is "none"; populated for "content-hash" entries).
 *   - rationale: required string when attestation_mode === "none"; optional
 *     otherwise. Captured as a refinement for AC2.2.
 *
 * Exports:
 *   - PerGateThresholdEntrySchema  -- per-gate entry validator
 *   - PerGateThresholdTableSchema  -- full table validator (record of entries)
 *   - ATTESTATION_MODES            -- frozen tuple of valid modes
 *   - validatePerGateThresholdTable(raw) -> parsed table (throws on invalid)
 *
 * Implements: REQ-001, REQ-002, AC2.6
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning / as-002
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Valid attestation modes (closed set).
 *
 * - "content-hash": gate clearance attested by hashing input_manifest contents
 *   (used for unifier, code-review, security, completion-verifier).
 * - "timestamp": gate clearance attested by pass timestamp only (reserved for
 *   future gates that cannot be content-hashed).
 * - "none": no attestation; pure pass-count tracking (investigation, challenger
 *   substages — findings intentionally vary across passes).
 *
 * @type {readonly ["content-hash", "timestamp", "none"]}
 */
export const ATTESTATION_MODES = Object.freeze(['content-hash', 'timestamp', 'none']);

const ATTESTATION_MODE_SET = new Set(ATTESTATION_MODES);

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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addUnknownKeyIssues(issues, value, allowedKeys, path) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push({
        path: [...path, key],
        message: 'unknown key',
      });
    }
  }
}

// =============================================================================
// Entry Schema
// =============================================================================

/**
 * Validate a single gate entry in the PerGateThresholdTable.
 */
function validateEntry(entry, path = []) {
  const issues = [];
  if (!isPlainObject(entry)) {
    return makeFailure([{ path, message: 'expected object' }]);
  }

  addUnknownKeyIssues(
    issues,
    entry,
    new Set([
      'required_clean_passes',
      'attestation_mode',
      'hash_input_manifest',
      'rationale',
    ]),
    path
  );

  if (
    !Number.isInteger(entry.required_clean_passes) ||
    entry.required_clean_passes < 1
  ) {
    issues.push({
      path: [...path, 'required_clean_passes'],
      message: 'required_clean_passes must be an integer >= 1',
    });
  }

  if (!ATTESTATION_MODE_SET.has(entry.attestation_mode)) {
    issues.push({
      path: [...path, 'attestation_mode'],
      message: `expected one of: ${ATTESTATION_MODES.join(', ')}`,
    });
  }

  if (
    !Array.isArray(entry.hash_input_manifest) ||
    !entry.hash_input_manifest.every((item) => typeof item === 'string')
  ) {
    issues.push({
      path: [...path, 'hash_input_manifest'],
      message: 'hash_input_manifest must be an array of strings',
    });
  }

  if (
    entry.rationale !== undefined &&
    (typeof entry.rationale !== 'string' || entry.rationale.length === 0)
  ) {
    issues.push({
      path: [...path, 'rationale'],
      message: 'rationale must be a non-empty string',
    });
  }

  if (entry.attestation_mode === 'none' && !entry.rationale) {
    issues.push({
      path: [...path, 'rationale'],
      message: 'rationale is required when attestation_mode is "none" (AC2.2)',
    });
  }

  if (issues.length > 0) {
    return makeFailure(issues);
  }

  const parsed = {
    required_clean_passes: entry.required_clean_passes,
    attestation_mode: entry.attestation_mode,
    hash_input_manifest: [...entry.hash_input_manifest],
  };
  if (entry.rationale !== undefined) {
    parsed.rationale = entry.rationale;
  }
  return makeSuccess(parsed);
}

export const PerGateThresholdEntrySchema = Object.freeze({
  safeParse(raw) {
    return validateEntry(raw);
  },
  parse(raw) {
    const result = validateEntry(raw);
    if (!result.success) throw result.error;
    return result.data;
  },
});

// =============================================================================
// Table Schema
// =============================================================================

/**
 * Schema-compatible validator for the full PerGateThresholdTable.
 *
 * Keys are gate names (strings). Values are PerGateThresholdEntry objects.
 * Enforced as a record (not a fixed object) so future gates can be added
 * without schema changes; AC2.1 coverage of the seven canonical gates is
 * enforced at the table-content module, not the schema.
 */
export const PerGateThresholdTableSchema = Object.freeze({
  safeParse(raw) {
    if (!isPlainObject(raw)) {
      return makeFailure([{ path: [], message: 'expected object' }]);
    }

    const issues = [];
    const parsed = {};
    for (const [gateName, entry] of Object.entries(raw)) {
      if (typeof gateName !== 'string' || gateName.length === 0) {
        issues.push({ path: [gateName], message: 'gate name must be non-empty' });
        continue;
      }
      const entryResult = validateEntry(entry, [gateName]);
      if (!entryResult.success) {
        issues.push(...entryResult.error.issues);
        continue;
      }
      parsed[gateName] = entryResult.data;
    }

    if (issues.length > 0) {
      return makeFailure(issues);
    }
    return makeSuccess(parsed);
  },
  parse(raw) {
    const result = this.safeParse(raw);
    if (!result.success) throw result.error;
    return result.data;
  },
});

export const perGateThresholdEntrySchema = PerGateThresholdEntrySchema;
export const perGateThresholdTableSchema = PerGateThresholdTableSchema;

// =============================================================================
// Validator
// =============================================================================

/**
 * Validate a raw table against PerGateThresholdTableSchema.
 *
 * Throws a validation error on invalid input (caller may wrap into a typed error).
 * Returns the parsed (frozen-after-parse responsibility of the caller) table.
 *
 * @param {unknown} raw
 * @returns {Record<string, { required_clean_passes: number, attestation_mode: string, hash_input_manifest: string[], rationale?: string }>}
 */
export function validatePerGateThresholdTable(raw) {
  return PerGateThresholdTableSchema.parse(raw);
}
