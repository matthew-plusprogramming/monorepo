#!/usr/bin/env node

/**
 * Validate manifest.json files against spec-group.schema.json.
 *
 * Logic:
 * 1. Accept manifest.json file path as argument
 * 2. Parse JSON
 * 3. Validate against .claude/specs/schema/spec-group.schema.json
 * 4. Report validation errors
 * 5. Exit 0 on valid, non-zero on invalid
 *
 * Usage:
 *   node validate-manifest.mjs <manifest.json>
 *
 * Exit codes:
 *   0 - Validation passed
 *   1 - Validation failed
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { validatePath } from './lib/path-validate.mjs';
import {
  normalizeSpecMode,
  SPEC_MODE_VALUES,
} from './lib/schemas/spec-mode.schema.mjs';

// Find the .claude directory by walking up from script location
function findClaudeDir() {
  let currentDir = dirname(resolve(import.meta.url.replace('file://', '')));
  const root = '/';

  while (currentDir !== root) {
    const claudeDir = join(currentDir, '.claude');
    if (existsSync(claudeDir)) {
      return claudeDir;
    }
    // Check if we're inside .claude
    if (basename(currentDir) === '.claude') {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  // Default to relative path from cwd
  return join(process.cwd(), '.claude');
}

const CLAUDE_DIR = findClaudeDir();
const SCHEMA_PATH = join(CLAUDE_DIR, 'specs', 'schema', 'spec-group.schema.json');

// ============================================================================
// as-010 / AC10.1, AC10.3 — SessionThresholdSnapshot reader (runtime path).
//
// validate-manifest.mjs is a runtime consumer that participates in the
// threshold-reader superset (spec
// §Contract:threshold-reader-superset). It reads per-gate
// `required_clean_passes` from `session.active_work.threshold_snapshot` --
// the immutable snapshot captured at `session-checkpoint.mjs start-work`
// by as-005.
//
// Fallback semantics (AC10.3): when the snapshot is absent (pre-as-005
// sessions, missing session.json, malformed JSON, or missing per-gate entry),
// the reader returns 2 -- the canonical 2-consecutive-clean default that
// pre-dated the pruning work. This preserves existing validator behavior
// during staggered rollout and is fail-open (validation should not reject
// manifests on transient session-read failures).
//
// Distinct from migrate-manifest.mjs's direct PerGateThresholdTable import:
// that consumer runs pre-session where no snapshot exists (AC10.2); this
// consumer runs during PostToolUse hook invocations where the snapshot is
// expected to be present.
// ============================================================================

/** Default `required_clean_passes` applied when snapshot-read falls through. */
const DEFAULT_REQUIRED_CLEAN_PASSES = 2;

/** Canonical session.json path relative to `.claude/`. */
const SESSION_RELATIVE_PATH = 'context/session.json';

/**
 * Read `required_clean_passes` for a gate from the session-scoped
 * SessionThresholdSnapshot. Returns `DEFAULT_REQUIRED_CLEAN_PASSES` (2) when:
 *   - the session.json file is absent
 *   - the file cannot be parsed as JSON
 *   - `active_work.threshold_snapshot.per_gate` is missing
 *   - the named gate has no entry in `per_gate`
 *   - the entry's `required_clean_passes` is not a number
 *
 * This fail-open posture (AC10.3) matches the hook-utils loadSession contract
 * and avoids cross-coupling validate-manifest to snapshot-capture availability.
 *
 * @param {string} gate — gate identifier matching PerGateThresholdTable keys
 *                        (e.g., "unifier", "code-review", "completion-verifier")
 * @returns {number} required_clean_passes for the gate
 */
function readSnapshotThreshold(gate) {
  if (!gate || typeof gate !== 'string') {
    return DEFAULT_REQUIRED_CLEAN_PASSES;
  }
  const sessionPath = join(CLAUDE_DIR, SESSION_RELATIVE_PATH);
  if (!existsSync(sessionPath)) {
    return DEFAULT_REQUIRED_CLEAN_PASSES;
  }
  let session;
  try {
    session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
  } catch {
    return DEFAULT_REQUIRED_CLEAN_PASSES;
  }
  const perGate = session?.active_work?.threshold_snapshot?.per_gate;
  if (!perGate || typeof perGate !== 'object') {
    return DEFAULT_REQUIRED_CLEAN_PASSES;
  }
  const entry = perGate[gate];
  if (!entry || typeof entry.required_clean_passes !== 'number') {
    return DEFAULT_REQUIRED_CLEAN_PASSES;
  }
  return entry.required_clean_passes;
}

/**
 * Load the spec-group schema.
 */
function loadSchema() {
  if (!existsSync(SCHEMA_PATH)) {
    console.error(`Schema file not found: ${SCHEMA_PATH}`);
    return null;
  }

  try {
    return JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Error loading schema: ${err.message}`);
    return null;
  }
}

/**
 * Simple JSON schema validator.
 * Validates required fields, types, enums, and patterns.
 */
function validateAgainstSchema(data, schema, path = '') {
  const errors = [];

  if (!schema || !data) {
    return errors;
  }

  // Check required fields
  if (schema.required && Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (data[field] === undefined) {
        errors.push(`${path}${field}: required field is missing`);
      }
    }
  }

  // Check properties
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const value = data[key];
      const propPath = path ? `${path}.${key}` : key;

      if (value === undefined) continue;

      // Type checking
      if (propSchema.type) {
        const types = Array.isArray(propSchema.type) ? propSchema.type : [propSchema.type];
        const valueType = Array.isArray(value) ? 'array' : typeof value;
        const typeMatch = types.some((t) => {
          if (t === 'array') return Array.isArray(value);
          if (t === 'null') return value === null;
          if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
          return typeof value === t;
        });

        if (!typeMatch) {
          errors.push(`${propPath}: expected type ${types.join('|')}, got ${valueType}`);
        }
      }

      // Enum checking
      if (propSchema.enum && !propSchema.enum.includes(value)) {
        errors.push(`${propPath}: value '${value}' not in allowed values [${propSchema.enum.join(', ')}]`);
      }

      // Pattern checking
      if (propSchema.pattern && typeof value === 'string') {
        const regex = new RegExp(propSchema.pattern);
        if (!regex.test(value)) {
          errors.push(`${propPath}: value '${value}' does not match pattern ${propSchema.pattern}`);
        }
      }

      // Format checking (basic)
      if (propSchema.format && typeof value === 'string') {
        if (propSchema.format === 'date-time') {
          const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
          if (!dateRegex.test(value)) {
            errors.push(`${propPath}: value '${value}' is not a valid date-time format`);
          }
        }
        if (propSchema.format === 'uri') {
          try {
            new URL(value);
          } catch {
            errors.push(`${propPath}: value '${value}' is not a valid URI`);
          }
        }
      }

      // Array items
      if (propSchema.type === 'array' && propSchema.items && Array.isArray(value)) {
        if (propSchema.minItems && value.length < propSchema.minItems) {
          errors.push(`${propPath}: array must have at least ${propSchema.minItems} items`);
        }
        for (let i = 0; i < value.length; i++) {
          const itemErrors = validateAgainstSchema(value[i], propSchema.items, `${propPath}[${i}].`);
          errors.push(...itemErrors);
        }
      }

      // Nested objects
      if (propSchema.type === 'object' && propSchema.properties && typeof value === 'object' && !Array.isArray(value)) {
        const nestedErrors = validateAgainstSchema(value, propSchema, `${propPath}.`);
        errors.push(...nestedErrors);
      }
    }
  }

  // Check for additional properties not in schema
  if (schema.additionalProperties === false && typeof data === 'object' && !Array.isArray(data)) {
    const allowedKeys = schema.properties ? Object.keys(schema.properties) : [];
    for (const key of Object.keys(data)) {
      if (!allowedKeys.includes(key)) {
        errors.push(`${path}${key}: additional property not allowed by schema`);
      }
    }
  }

  return errors;
}

/**
 * Map of legacy-flat top-level fields to their canonical nested equivalents.
 * Used to emit the three-part actionable error per NFR-5 / AC-2.2.
 */
const LEGACY_FLAT_TO_NESTED = {
  prd_id: 'prd.id',
  prd_path: 'prd.file_path',
  prd_version: 'prd.version',
  prd_content_hash: 'prd.content_hash',
  spec_group_id: '(drop — duplicates canonical `id`)',
};

/**
 * Detect legacy-flat shape and return a three-part actionable error per AC-2.2:
 *   (a) offending field name, (b) canonical nested equivalent, (c) migrate-manifest.mjs path.
 * @returns {string[]} Error lines, empty if no legacy-flat fields present.
 */
function detectLegacyFlatShape(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return errors;
  for (const key of Object.keys(LEGACY_FLAT_TO_NESTED)) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const canonical = LEGACY_FLAT_TO_NESTED[key];
      errors.push(
        `legacy-flat field '${key}' is rejected. Canonical equivalent: ${canonical}. ` +
          `Run \`node .claude/scripts/migrate-manifest.mjs --all\` to migrate.`
      );
    }
  }
  // Defense-in-depth: non-canonical convergence subfields (inv-contract-a26e31 / AC-1a).
  if (data.convergence && typeof data.convergence === 'object' && !Array.isArray(data.convergence)) {
    for (const key of Object.keys(data.convergence)) {
      if (key.endsWith('_clean_pass_count')) {
        // as-010 / AC10.1: read the canonical per-gate threshold from the
        // SessionThresholdSnapshot and surface it in the structured rejection.
        // The threshold value is informational (the subfield is rejected
        // regardless); reading from the snapshot is the contract (spec
        // §Contract:threshold-reader-superset -- validate-manifest).
        // Fail-open fallback to 2 per AC10.3 when the
        // snapshot is absent.
        const gate = gateFromCleanPassCountKey(key);
        const threshold = readSnapshotThreshold(gate);
        errors.push(
          `non-canonical convergence subfield 'convergence.${key}' is rejected ` +
            `(canonical threshold for gate='${gate ?? 'unknown'}' is ${threshold} clean pass(es) per session snapshot). ` +
            `clean_pass_count tracking lives in session.json (see session-checkpoint.mjs update-convergence). ` +
            `Run \`node .claude/scripts/migrate-manifest.mjs --all\` to migrate.`
        );
      }
    }
  }
  return errors;
}

/**
 * Map a `<name>_clean_pass_count` subfield key back to the canonical gate
 * identifier used by PerGateThresholdTable / SessionThresholdSnapshot.
 *
 * Mirrors the mapping in migrate-manifest.mjs; the two consumers use
 * identical prefix translation so operator-facing error messages stay aligned.
 * Unknown prefixes return `null` and the caller falls back to the default
 * threshold.
 *
 * @param {string} subfieldKey — e.g., "unifier_clean_pass_count"
 * @returns {string|null} gate name (e.g., "unifier") or null when unmapped
 */
function gateFromCleanPassCountKey(subfieldKey) {
  const CLEAN_PASS_COUNT_SUFFIX = '_clean_pass_count';
  if (!subfieldKey.endsWith(CLEAN_PASS_COUNT_SUFFIX)) return null;
  const prefix = subfieldKey.slice(0, -CLEAN_PASS_COUNT_SUFFIX.length);
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
 * Validate a manifest.json file.
 *
 * Returned shape
 *   - errors, warnings: conventional validator result lists.
 *   - data: the parsed manifest object AFTER normalization passes (currently
 *     applies the `spec_mode` fail-closed default per as-001 / AC1.2). Returned
 *     on success AND on partial-failure paths so callers can introspect what
 *     the validator would accept. `undefined` on catastrophic-parse failure.
 */
function validateManifest(filePath) {
  const errors = [];
  const warnings = [];

  if (!existsSync(filePath)) {
    errors.push(`File not found: ${filePath}`);
    return { errors, warnings, data: undefined };
  }

  // Verify it's a JSON file
  if (!filePath.endsWith('.json')) {
    warnings.push('File does not have .json extension');
  }

  // Parse JSON
  let data;
  try {
    const content = readFileSync(filePath, 'utf-8');
    data = JSON.parse(content);
  } catch (err) {
    errors.push(`Invalid JSON: ${err.message}`);
    return { errors, warnings, data: undefined };
  }

  // Load schema
  const schema = loadSchema();
  if (!schema) {
    errors.push('Could not load spec-group schema');
    return { errors, warnings, data };
  }

  // AC-2.1 + AC-2.2: three-part legacy-flat detection BEFORE schema validation
  // so operators see the actionable migration hint before any other error.
  errors.push(...detectLegacyFlatShape(data));

  // -----------------------------------------------------------------------
  // as-001 / AC1.1, AC1.2, AC1.3 — spec_mode normalization + validation.
  //
  // This block runs BEFORE JSON-Schema validation so that:
  //   - AC1.2 (absent → default 'feature') mutates `data` in place so the
  //     downstream validator sees the canonical shape. Callers that inspect
  //     `data` after this function returns see the normalized value.
  //   - AC1.3 (invalid → structured rejection) surfaces a typed error with
  //     the field name + allowed enum values BEFORE the generic JSON-Schema
  //     enum error fires. The structured error is the contract-visible shape
  //     downstream consumers (record-test-writer-unlock CLI preflight,
  //     as-003) will read; emitting it first keeps the error message tied
  //     to the spec-owner (ws-2) rather than the schema-generic form.
  //
  // Note: JSON-Schema validation below *also* catches enum mismatches via
  // the `spec-group.schema.json` `enum` keyword. Both errors can surface for
  // the same invalid value; this is acceptable — the first one names the
  // field + allowed values in the structured form that matches the Zod
  // schema consumed by as-003.
  // -----------------------------------------------------------------------
  const specModeResult = normalizeSpecMode(data);
  if (!specModeResult.ok) {
    const allowed = SPEC_MODE_VALUES.join(', ');
    errors.push(
      `spec_mode: value '${String(specModeResult.error.observed)}' ` +
        `not in allowed values [${allowed}] ` +
        `(per as-001 SpecManifestModeField contract).`
    );
  }

  // Validate against schema
  const schemaErrors = validateAgainstSchema(data, schema);
  errors.push(...schemaErrors);

  // AC-1.6: path-validate `prd.file_path` before accepting the manifest.
  // The shared helper enforces the POSIX containment ruleset (reject `..`,
  // absolute paths, symlinks via fs.lstat) so a crafted manifest cannot
  // reference files outside the repo. Kept non-throwing to preserve the
  // aggregate-error shape; structured-error-validator traces the reject via
  // the `PATH_VALIDATE_REJECT:` prefix (mirrors err.code from assertValidPath).
  if (data && typeof data === 'object' && !Array.isArray(data) && data.prd && typeof data.prd === 'object' && !Array.isArray(data.prd)) {
    const candidate = data.prd.file_path;
    // Only validate when the field is present — `prd.file_path` is optional
    // in the canonical schema (some manifests carry only `prd.source`).
    if (candidate !== undefined) {
      const projectRootForValidation = dirname(dirname(dirname(dirname(resolve(filePath)))));
      const result = validatePath(candidate, {
        allowNull: true,
        projectRoot: projectRootForValidation,
      });
      if (!result.valid) {
        const detail = result.detail ? `: ${result.detail}` : '';
        errors.push(
          `PATH_VALIDATE_REJECT: prd.file_path rejected (${result.reason}${detail})`
        );
      }
    }
  }

  // Additional semantic validations

  // Check that review_state and work_state are compatible
  if (data.review_state && data.work_state) {
    if (data.review_state === 'DRAFT' && data.work_state !== 'PLAN_READY') {
      warnings.push(
        `Unusual state: review_state is DRAFT but work_state is ${data.work_state}. ` +
          `Typically work should not begin until spec is approved.`
      );
    }
    if (data.review_state !== 'APPROVED' && ['IMPLEMENTING', 'VERIFYING', 'READY_TO_MERGE'].includes(data.work_state)) {
      warnings.push(
        `State warning: work_state is ${data.work_state} but review_state is ${data.review_state}. ` +
          `Implementation should typically wait for APPROVED status.`
      );
    }
  }

  // Check convergence consistency
  if (data.convergence) {
    if (data.convergence.all_tests_passing && !data.convergence.all_acs_implemented) {
      warnings.push('Convergence inconsistency: all_tests_passing is true but all_acs_implemented is false');
    }
    if (data.convergence.unifier_passed && !data.convergence.all_tests_passing) {
      warnings.push('Convergence inconsistency: unifier_passed is true but all_tests_passing is false');
    }
  }

  return { errors, warnings, data };
}

// Exposed for direct-import test consumers (e.g., validate-manifest-spec-mode.test.mjs).
// The CLI entry point (`main`) does not depend on this export; it remains
// internal in behavior but `export`ed so tests don't have to spawn subprocesses
// to reach the normalized `data` that carries the AC1.2 default.
export { validateManifest };

// --------------------------------------------------------------------------
// Module-scope guard: only run `main()` when invoked as a CLI, not when
// imported (as tests / downstream consumers now do via the `validateManifest`
// export above). Mirrors the convention used in migrate-manifest.mjs.
// --------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: validate-manifest.mjs <manifest.json> [manifest2.json ...]');
    console.error('Error: No files provided.');
    process.exit(1);
  }

  let hasErrors = false;
  let hasWarnings = false;

  for (const arg of args) {
    const filePath = resolve(arg);
    console.error(`Validating: ${basename(filePath)}`);

    const { errors, warnings } = validateManifest(filePath);

    // Print warnings
    for (const warning of warnings) {
      hasWarnings = true;
      console.error(`Warning: ${warning}`);
    }

    // Print errors
    for (const error of errors) {
      hasErrors = true;
      console.error(`Error: ${error}`);
    }

    if (errors.length === 0) {
      console.error(`Manifest ${basename(filePath)} is valid.`);
    }

    console.error('');
  }

  if (hasErrors) {
    console.error('Validation failed.');
    process.exit(1);
  }

  if (args.length > 1) {
    console.error(`Validated ${args.length} manifest(s) successfully.`);
  }

  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
