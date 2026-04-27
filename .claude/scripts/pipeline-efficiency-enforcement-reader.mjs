#!/usr/bin/env node

/**
 * Pipeline-Efficiency Enforcement-flag Reader
 *
 * Reads `.claude/config/pipeline-efficiency-enforcement.json`, validates
 * against `enforcementConfigSchema`, and exposes the current mode + source
 * label consumed by `session-checkpoint.mjs start-work` when it captures
 * the immutable `SessionThresholdSnapshot.source` field.
 *
 * Contract surface (AC15.4, AC15.5):
 *   - getCurrentMode(opts?): "advisory" | "coercive" | "off"
 *       Missing file → "advisory" (safe default aligned with REQ-013
 *       first-session-after-rollout behavior — spec.md § Edge Cases
 *       "First session after rollout, no baseline yet").
 *   - getSourceLabel(opts?): string
 *       Missing file → "hardcoded-default" (EC-13 fallback family).
 *       Present + valid → "enforcement-flag-<mode>" template per AC15.4.
 *       Snapshot writers (as-005 / session-checkpoint start-work) are
 *       responsible for any further normalization (e.g., mapping
 *       "enforcement-flag-off" → three-enum `SessionThresholdSnapshot.source`
 *       per spec.md:443). That normalization is out of scope for E2.
 *   - ENFORCEMENT_CONFIG_INVALID: structured error thrown when the file
   *     exists but fails schema validation (malformed JSON, unknown key,
 *     bad mode, missing field).
 *
 * Fail semantics (AC15.5):
 *   - File missing / ENOENT      → advisory + "hardcoded-default" (no throw).
 *   - File unreadable (other IO) → ENFORCEMENT_CONFIG_INVALID (throw).
 *   - JSON parse failure         → ENFORCEMENT_CONFIG_INVALID (throw).
 *   - Schema validation failure  → ENFORCEMENT_CONFIG_INVALID (throw).
 *
 * All external input is validated at this boundary. Downstream consumers
 * receive the already-validated mode + label; no re-validation.
 *
 * Implements: REQ-013, AC15.4, AC15.5
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning (Phase E, Task E2)
 * Requires: as-003 (enforcement-config.schema.mjs)
 *
 * Usage:
 *   import { getCurrentMode, getSourceLabel } from
 *     './pipeline-efficiency-enforcement-reader.mjs';
 *   const mode   = getCurrentMode();       // resolved against default path
 *   const source = getSourceLabel();       // paired output for snapshot
 */

import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  getCanonicalProjectDir,
  CanonicalProjectDirError,
} from './lib/hook-utils.mjs';
import { enforcementConfigSchema } from './lib/schemas/enforcement-config.schema.mjs';

// =============================================================================
// Constants
// =============================================================================

/**
 * Default mode used when the flag file is absent.
 * Aligned with spec.md § Edge Cases "First session after rollout, no baseline
 * yet" — enforcement-flag stays at `advisory` in the absence of an explicit
 * on-disk decision.
 */
const DEFAULT_MODE_WHEN_FILE_MISSING = 'advisory';

/**
 * Source label used when the flag file is absent.
 * Matches the `SessionThresholdSnapshot.source` fallback value defined in
 * spec.md:443 (three-enum: hardcoded-default | enforcement-flag-advisory |
 * enforcement-flag-coercive) — see EC-13 fallback family.
 */
const HARDCODED_DEFAULT_SOURCE_LABEL = 'hardcoded-default';

/**
 * Relative `.claude/`-path of the on-disk flag file.
 * Kept as separate segments so the path can be resolved against both the
 * canonical project root (`getCanonicalProjectDir()`) AND an injected
 * override path (tests).
 */
const FLAG_FILE_SEGMENTS = ['config', 'pipeline-efficiency-enforcement.json'];

/**
 * Source-label template. Re-derived verbatim from AC15.4:
 *   `getSourceLabel() returns "enforcement-flag-<mode>"`.
 */
const SOURCE_LABEL_PREFIX = 'enforcement-flag-';

// =============================================================================
// Structured error
// =============================================================================

/**
 * Thrown when the flag file exists but fails validation (malformed JSON,
 * unknown key, bad mode, missing field, or IO error other than ENOENT).
 *
 * Follows the project error-class convention: machine-readable `code`, a
 * human-readable `message`, `blame` (here: `upstream` — the operator-authored
 * file is the failing input), and `retry_safe: false` (manual operator
 * action required to fix).
 */
export class EnforcementConfigInvalidError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'EnforcementConfigInvalidError';
    this.code = 'ENFORCEMENT_CONFIG_INVALID';
    this.blame = 'upstream';
    this.retry_safe = false;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Resolve the absolute path to the flag file.
 *
 * Honors an explicit override (`opts.path`) when provided — used by tests
 * to point the reader at a fixture directory without touching the real
 * project root. Otherwise resolves against the canonical project dir so
 * symlink-based traversal cannot redirect the read.
 *
 * On `CanonicalProjectDirError` the reader falls back to `cwd/.claude` to
 * stay consistent with `workflow-file-protection.mjs` behavior (Path (2)
 * legacy fallback). This is the narrow compatibility path; any IO error
 * during the subsequent read is surfaced via `ENFORCEMENT_CONFIG_INVALID`
 * (not silently squashed).
 *
 * @param {{ path?: string }} opts
 * @returns {string} absolute path to the flag file
 */
function resolveFlagFilePath(opts) {
  if (opts && typeof opts.path === 'string' && opts.path.length > 0) {
    return resolve(opts.path);
  }
  let claudeDir;
  try {
    const projectRoot = getCanonicalProjectDir();
    claudeDir = `${projectRoot}${sep}.claude`;
  } catch (err) {
    if (!(err instanceof CanonicalProjectDirError)) throw err;
    claudeDir = `${process.cwd()}${sep}.claude`;
  }
  return [claudeDir, ...FLAG_FILE_SEGMENTS].join(sep);
}

/**
 * Read + validate the flag file. Returns either:
 *   - `{ present: false }`              when the file is absent (ENOENT), OR
 *   - `{ present: true, config }`       with the validated EnforcementConfig.
 *
 * Throws `EnforcementConfigInvalidError` on any other failure (IO error,
 * JSON parse error, schema-validation error).
 *
 * @param {{ path?: string }} [opts]
 * @returns {{ present: false } | { present: true, config: import('./lib/schemas/enforcement-config.schema.mjs').EnforcementConfig }}
 */
function loadConfig(opts = {}) {
  const filePath = resolveFlagFilePath(opts);
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { present: false };
    }
    throw new EnforcementConfigInvalidError(
      `Failed to read enforcement-flag file at ${filePath}: ${err && err.message ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EnforcementConfigInvalidError(
      `Failed to parse enforcement-flag file JSON at ${filePath}: ${err && err.message ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const result = enforcementConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new EnforcementConfigInvalidError(
      `Enforcement-flag file at ${filePath} failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }

  return { present: true, config: result.data };
}

// =============================================================================
// Public API (AC15.4)
// =============================================================================

/**
 * Return the current enforcement mode.
 *
 * - Flag file absent           → `DEFAULT_MODE_WHEN_FILE_MISSING` ("advisory").
 * - Flag file present + valid  → `config.mode` ("advisory"|"coercive"|"off").
 * - Flag file invalid          → throws `EnforcementConfigInvalidError`.
 *
 * @param {{ path?: string }} [opts] — optional override for tests.
 * @returns {"advisory" | "coercive" | "off"}
 */
export function getCurrentMode(opts = {}) {
  const loaded = loadConfig(opts);
  if (!loaded.present) {
    return DEFAULT_MODE_WHEN_FILE_MISSING;
  }
  return loaded.config.mode;
}

/**
 * Return the `source` label corresponding to the flag-file state.
 *
 * - Flag file absent           → `"hardcoded-default"` (EC-13 fallback family).
 * - Flag file present + valid  → `"enforcement-flag-<mode>"` (AC15.4 template).
 * - Flag file invalid          → throws `EnforcementConfigInvalidError`.
 *
 * Downstream snapshot writers (as-005 / session-checkpoint start-work) own
 * any further normalization against the three-enum
 * `SessionThresholdSnapshot.source` constraint (spec.md:443). That mapping
 * is explicitly out of scope for the reader (AC15.4 mandates the literal
 * template here).
 *
 * @param {{ path?: string }} [opts] — optional override for tests.
 * @returns {string}
 */
export function getSourceLabel(opts = {}) {
  const loaded = loadConfig(opts);
  if (!loaded.present) {
    return HARDCODED_DEFAULT_SOURCE_LABEL;
  }
  return `${SOURCE_LABEL_PREFIX}${loaded.config.mode}`;
}
