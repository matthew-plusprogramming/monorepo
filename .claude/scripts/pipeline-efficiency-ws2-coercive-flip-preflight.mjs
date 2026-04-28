#!/usr/bin/env node

/**
 * pipeline-efficiency-ws2-coercive-flip-preflight.mjs
 *
 * ws-2 Practice-2.4 coercive-flip preflight wrapper. Checks:
 *   1. Delegates the full 3-workstream preflight to
 *      `pipeline-efficiency-coercive-flip-preflight.mjs`, which reads the
 *      kill-switch sentinel, enforcement-flag, audit-log HEAD, and all three
 *      canonical per-workstream baselines including
 *      `.claude/metrics/pipeline-efficiency-ws2-baseline.json`.
 *   2. Focuses rejection diagnostics on the ws-2 workstream — if the only
 *      baseline problem is ws-2's, we emit structured ws-2-scoped errors
 *      (`WS2_BASELINE_ABSENT`, `WS2_BASELINE_SCHEMA_INVALID`,
 *      `WS2_BASELINE_INSUFFICIENT`) so operators see the direct ws-2 cause
 *      instead of the generic 3-way enumeration.
 *   3. Applies the per-workstream override at
 *      `.claude/metrics/sg-pipeline-efficiency-ws2-practice-2.4-baseline-override.json`
 *      — the override ONLY unblocks the "undersized ws-2 baseline" branch.
 *      It does NOT unblock ABSENT or SCHEMA_INVALID; it also does NOT
 *      propagate to ws-1 / ws-3 baseline problems.
 *
 * Relationship to the shared preflight:
 *   - The shared preflight is the 3-workstream gate. It owns the kill-switch sentinel
 *     check, enforcement-flag read, and audit-log HEAD read — all of which
 *     are cross-cutting concerns that are not ws-2-specific.
 *   - This wrapper is invoked when an operator specifically wants to flip
 *     the Practice-2.4 hybrid-mode gate to coercive. It consumes the shared
 *     preflight result and re-maps rejections through the ws-2 scope lens.
 *   - If any rejection is NOT ws-2's baseline problem (sentinel / enforcement
 *     flag / audit HEAD / ws-1 baseline / ws-3 baseline), this wrapper
 *     surfaces the shared preflight's rejection verbatim — the override does
 *     NOT bypass those failures.
 *
 * CLI exit codes:
 *   0  — ACCEPTED
 *   2  — REJECTED (any structured failure surfaced from ws-1 preflight or
 *        from the ws-2 override validator)
 *   1  — UNEXPECTED_ERROR
 *
 * Programmatic callers:
 *   import { runWs2Preflight } from './pipeline-efficiency-ws2-coercive-flip-preflight.mjs';
 *   const result = runWs2Preflight({ projectRoot });
 *   // result: { accepted: boolean, code: string, details, override_applied, ... }
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getCanonicalProjectDir,
  CanonicalProjectDirError,
} from './lib/hook-utils.mjs';
import {
  runPreflight,
  PREFLIGHT_ERROR_CODES,
} from './pipeline-efficiency-coercive-flip-preflight.mjs';
import {
  validateBaselineOverride,
  BaselineSchemaError,
} from './lib/schemas/baseline.schema.mjs';
import { WS2_BASELINE_RELATIVE_PATH } from './pipeline-efficiency-ws2-baseline-accumulator.mjs';

// =============================================================================
// Constants — canonical paths
// =============================================================================

/**
 * Canonical ws-2 override path.
 *
 * Scoped to the FULL spec-group ID `sg-pipeline-efficiency-ws2-practice-2.4`
 * — the filename pins the override to this workstream only; an override file
 * at any other path is NOT recognized and cannot unblock this preflight.
 *
 * Override scope is enforced at TWO layers:
 *   (a) filename — only this exact path is read.
 *   (b) content — `validateBaselineOverride` enforces the override schema
 *       (including `workstream_id`). The wrapper additionally verifies the
 *       override's `workstream_id` matches the ws-2 spec-group or the
 *       short-form `ws-2` id before honoring it.
 */
export const WS2_BASELINE_OVERRIDE_RELATIVE_PATH =
  '.claude/metrics/sg-pipeline-efficiency-ws2-practice-2.4-baseline-override.json';

/** Full historical workstream id for the ws-2 Practice-2.4 override. */
export const WS2_SPEC_GROUP_ID = 'sg-pipeline-efficiency-ws2-practice-2.4';

/** Short-form workstream id accepted by `workstream_id` override field. */
export const WS2_SHORT_ID = 'ws-2';

/** ws-2 baseline identity inside the 3-way preflight result. */
const WS2_WS_ID = 'ws-2';

// =============================================================================
// Constants — CLI exit codes
// =============================================================================

const EXIT_ACCEPTED = 0;
const EXIT_UNEXPECTED = 1;
const EXIT_REJECTED = 2;

// =============================================================================
// Structured-error codes (ws-2 scope lens over ws-1 preflight)
// =============================================================================

/**
 * ws-2-scoped error codes emitted when the only baseline failure is ws-2's.
 *
 * When the ws-1 preflight rejects for a non-ws-2 reason (sentinel,
 * enforcement flag, audit HEAD, or a non-ws-2 baseline problem), this
 * wrapper re-emits the ws-1 rejection code verbatim.
 */
export const WS2_PREFLIGHT_ERROR_CODES = Object.freeze({
  WS2_BASELINE_ABSENT: 'WS2_BASELINE_ABSENT',
  WS2_BASELINE_SCHEMA_INVALID: 'WS2_BASELINE_SCHEMA_INVALID',
  WS2_BASELINE_INSUFFICIENT: 'WS2_BASELINE_INSUFFICIENT',
  WS2_OVERRIDE_INVALID: 'WS2_OVERRIDE_INVALID',
  WS2_OVERRIDE_SCOPE_MISMATCH: 'WS2_OVERRIDE_SCOPE_MISMATCH',
});

// =============================================================================
// Helpers
// =============================================================================

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
 * Inspect the ws-1 preflight result and determine whether the rejection is
 * ATTRIBUTABLE to the ws-2 baseline ONLY. If yes, return the ws-2-scoped
 * error code + details; if no (rejection is from a non-ws-2 concern), return
 * `null` — the caller must surface the ws-1 rejection verbatim.
 *
 * @param {object} result ws-1 preflight result
 * @returns {{ code: string, details: object } | null}
 */
function extractWs2ScopedFailure(result) {
  if (!result || result.accepted) return null;

  const baselines = result.baselines;
  if (!baselines) return null;

  switch (result.code) {
    case PREFLIGHT_ERROR_CODES.BASELINES_INCOMPLETE: {
      // ws-2-scoped iff ws-2 is in the missing list AND it's the ONLY one
      // missing. If ws-1 or ws-3 is also missing, the override does not
      // apply (AC10.4 scope) — we surface the generic rejection.
      const ws2Missing = baselines.missing.find((m) => m.ws_id === WS2_WS_ID);
      if (!ws2Missing) return null;
      if (baselines.missing.length !== 1) return null;
      return {
        code: WS2_PREFLIGHT_ERROR_CODES.WS2_BASELINE_ABSENT,
        details: {
          ws_id: WS2_WS_ID,
          path: ws2Missing.path,
          message:
            `ws-2 Practice-2.4 baseline is ABSENT at ${ws2Missing.path}. ` +
            `Run the accumulator (pipeline-efficiency-ws2-baseline-accumulator.mjs) ` +
            `to publish a baseline before retrying coercive flip. ` +
            `Override (${WS2_BASELINE_OVERRIDE_RELATIVE_PATH}) does NOT unblock ` +
            `ABSENT baselines — only UNDERSIZED per AC10.3.`,
        },
      };
    }
    case PREFLIGHT_ERROR_CODES.BASELINE_SCHEMA_INVALID: {
      const ws2Invalid = baselines.schema_invalid.find((s) => s.ws_id === WS2_WS_ID);
      if (!ws2Invalid) return null;
      if (baselines.schema_invalid.length !== 1) return null;
      return {
        code: WS2_PREFLIGHT_ERROR_CODES.WS2_BASELINE_SCHEMA_INVALID,
        details: {
          ws_id: WS2_WS_ID,
          path: ws2Invalid.path,
          reason: ws2Invalid.reason,
          message:
            `ws-2 Practice-2.4 baseline at ${ws2Invalid.path} is schema-INVALID. ` +
            `Override (${WS2_BASELINE_OVERRIDE_RELATIVE_PATH}) does NOT unblock ` +
            `schema-invalid baselines — only UNDERSIZED per AC10.3. ` +
            `Operator must re-publish a schema-valid baseline before retrying.`,
        },
      };
    }
    case PREFLIGHT_ERROR_CODES.BASELINE_INSUFFICIENT: {
      const ws2Insufficient = baselines.insufficient.find((s) => s.ws_id === WS2_WS_ID);
      if (!ws2Insufficient) return null;
      if (baselines.insufficient.length !== 1) return null;
      return {
        code: WS2_PREFLIGHT_ERROR_CODES.WS2_BASELINE_INSUFFICIENT,
        details: {
          ws_id: WS2_WS_ID,
          path: ws2Insufficient.path,
          sample_count: ws2Insufficient.sample_count,
          message:
            `ws-2 Practice-2.4 baseline sample_count=${ws2Insufficient.sample_count} ` +
            `is BELOW the REQ-011 sufficiency threshold ` +
            `(sample_count >= 10 OR window span >= 30d). ` +
            `An operator MAY unblock this via a scoped override at ` +
            `${WS2_BASELINE_OVERRIDE_RELATIVE_PATH} (AC10.3).`,
        },
      };
    }
    default:
      // Sentinel, audit-log HEAD, enforcement-flag, or race_abort — none of
      // these are ws-2-scoped; the override does not apply.
      return null;
  }
}

/**
 * Read + validate the ws-2 scoped override file.
 *
 * Returns:
 *   - `{ present: false }` when the override file does not exist.
 *   - `{ present: true, valid: true, override }` when schema-valid AND scope
 *     matches ws-2 (workstream_id ∈ {WS2_SPEC_GROUP_ID, WS2_SHORT_ID}).
 *   - `{ present: true, valid: false, code, details }` on schema or scope
 *     failure — the outer wrapper converts these to a rejection.
 *
 * @param {string} projectRoot
 * @returns {{ present: false } | {
 *   present: true, valid: true, override: object, path: string
 * } | {
 *   present: true, valid: false, code: string, details: object, path: string
 * }}
 */
function readWs2Override(projectRoot) {
  const overridePath = join(projectRoot, WS2_BASELINE_OVERRIDE_RELATIVE_PATH);
  if (!existsSync(overridePath)) {
    return { present: false };
  }
  let raw;
  try {
    raw = readFileSync(overridePath, 'utf-8');
  } catch (err) {
    return {
      present: true,
      valid: false,
      code: WS2_PREFLIGHT_ERROR_CODES.WS2_OVERRIDE_INVALID,
      details: {
        path: overridePath,
        message: `ws-2 override file unreadable: ${err && err.message ? err.message : String(err)}`,
      },
      path: overridePath,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      present: true,
      valid: false,
      code: WS2_PREFLIGHT_ERROR_CODES.WS2_OVERRIDE_INVALID,
      details: {
        path: overridePath,
        message: `ws-2 override file is not valid JSON: ${err && err.message ? err.message : String(err)}`,
      },
      path: overridePath,
    };
  }
  let override;
  try {
    override = validateBaselineOverride(parsed, {
      sourceLabel: `ws-2 override ${overridePath}`,
    });
  } catch (err) {
    const detail =
      err instanceof BaselineSchemaError
        ? err.message
        : err && err.message
          ? err.message
          : String(err);
    return {
      present: true,
      valid: false,
      code: WS2_PREFLIGHT_ERROR_CODES.WS2_OVERRIDE_INVALID,
      details: {
        path: overridePath,
        message: detail,
      },
      path: overridePath,
    };
  }
  // AC10.4 scope check — override must be for ws-2. Accept either the full
  // spec-group ID (preferred per AC10.4) or the short-form `ws-2` id (ws-1
  // baseline-override fixtures use the short form; we accept both to avoid
  // cross-workstream drift when scope is otherwise unambiguous).
  const acceptedIds = [WS2_SPEC_GROUP_ID, WS2_SHORT_ID];
  if (!acceptedIds.includes(override.workstream_id)) {
    return {
      present: true,
      valid: false,
      code: WS2_PREFLIGHT_ERROR_CODES.WS2_OVERRIDE_SCOPE_MISMATCH,
      details: {
        path: overridePath,
        workstream_id: override.workstream_id,
        accepted: acceptedIds,
        message:
          `ws-2 override workstream_id=${override.workstream_id} does NOT match ` +
          `ws-2 scope (accepted ids: ${acceptedIds.join(', ')}). ` +
          `Override is rejected — AC10.4 forbids cross-workstream propagation.`,
      },
      path: overridePath,
    };
  }
  return {
    present: true,
    valid: true,
    override,
    path: overridePath,
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run the ws-2 Practice-2.4 coercive-flip preflight.
 *
 * Non-throwing for all structured rejections; unanticipated errors bubble to
 * the CLI's `UNEXPECTED_ERROR` path.
 *
 * @param {{ projectRoot?: string }} [opts]
 * @returns {{
 *   accepted: boolean,
 *   code: string,
 *   details: object,
 *   ws1_preflight: object,
 *   ws2_scoped: { code: string, details: object } | null,
 *   override: { present: boolean, applied?: boolean, valid?: boolean, path?: string, override?: object, details?: object } | null,
 * }}
 */
export function runWs2Preflight(opts = {}) {
  const projectRoot = resolveProjectRoot(opts);

  // Step 1: delegate to ws-1 as-020 3-workstream preflight.
  const ws1Result = runPreflight({ projectRoot });

  const ws2OverrideAcceptedByWs1 =
    ws1Result.accepted === true &&
    Array.isArray(ws1Result.baselines?.override?.insufficient_overridden) &&
    ws1Result.baselines.override.insufficient_overridden.some(
      (entry) => entry.ws_id === WS2_WS_ID
    );

  if (ws2OverrideAcceptedByWs1) {
    const override = readWs2Override(projectRoot);
    const overridden = ws1Result.baselines.override.insufficient_overridden.find(
      (entry) => entry.ws_id === WS2_WS_ID
    );
    const ws2Scoped = {
      code: WS2_PREFLIGHT_ERROR_CODES.WS2_BASELINE_INSUFFICIENT,
      details: {
        ws_id: WS2_WS_ID,
        path: overridden?.path ?? null,
        sample_count: overridden?.sample_count ?? null,
      },
    };

    if (!override.present || !override.valid) {
      return {
        accepted: false,
        code: override.present
          ? override.code
          : WS2_PREFLIGHT_ERROR_CODES.WS2_OVERRIDE_INVALID,
        details: {
          ...(override.present ? override.details : {}),
          underlying_cause: ws2Scoped.code,
          message: override.present
            ? `ws-2 baseline is UNDERSIZED and the scoped override is invalid: ${override.details.message}`
            : 'ws-1 preflight reported ws-2 override acceptance, but the override file is absent.',
        },
        ws1_preflight: ws1Result,
        ws2_scoped: ws2Scoped,
        override: override.present
          ? {
              present: true,
              applied: false,
              valid: false,
              path: override.path,
              details: override.details,
            }
          : { present: false, applied: false },
      };
    }

    return {
      accepted: true,
      code: 'ACCEPTED_WITH_OVERRIDE',
      details: {
        message:
          'ws-2 Practice-2.4 preflight ACCEPTED via scoped override. ' +
          `Baseline was UNDERSIZED (${ws2Scoped.code}); operator ` +
          `"${override.override.operator}" accepted the risk with rationale: ` +
          `"${override.override.rationale}". Override scope: ${override.override.workstream_id}.`,
        override_path: override.path,
        override_workstream_id: override.override.workstream_id,
        override_effective_at: override.override.effective_at,
      },
      ws1_preflight: ws1Result,
      ws2_scoped: ws2Scoped,
      override: {
        present: true,
        applied: true,
        valid: true,
        path: override.path,
        override: override.override,
      },
    };
  }

  // Happy path: ws-1 preflight accepts → ws-2 accepts (all 3 baselines are
  // already present, schema-valid, and sufficient; the override file — if
  // any — is ignored because nothing needs unblocking).
  if (ws1Result.accepted) {
    return {
      accepted: true,
      code: 'ACCEPTED',
      details: {
        message:
          'ws-2 Practice-2.4 preflight passed: ws-1 3-workstream preflight accepted ' +
          '(all 3 baselines present, schema-valid, sufficient; sentinel absent; ' +
          'audit-log HEAD readable).',
      },
      ws1_preflight: ws1Result,
      ws2_scoped: null,
      override: null,
    };
  }

  // Step 2: identify whether the rejection is ws-2-scoped.
  const ws2Scoped = extractWs2ScopedFailure(ws1Result);

  if (!ws2Scoped) {
    // Non-ws-2 rejection (sentinel, enforcement flag, audit HEAD, ws-1 /
    // ws-3 baseline problems). Override CANNOT apply — surface the ws-1
    // rejection verbatim. AC10.4 scope containment.
    return {
      accepted: false,
      code: ws1Result.code,
      details: {
        message:
          `ws-2 preflight delegated to ws-1 3-workstream preflight; ` +
          `rejection cause is NOT ws-2-specific. The ws-2 scoped override ` +
          `does not apply (AC10.4 scope). Cause: ${ws1Result.code}.`,
        ws1_details: ws1Result.details,
      },
      ws1_preflight: ws1Result,
      ws2_scoped: null,
      override: null,
    };
  }

  // Step 3: ws-2-scoped failure. Check for override.
  const override = readWs2Override(projectRoot);

  // ABSENT + SCHEMA_INVALID are not overridable (AC10.3 limits override to
  // UNDERSIZED — the override is a "we know the sample is small but we
  // accept the risk" operator signal, not a "pretend the file exists"
  // signal).
  const overridable =
    ws2Scoped.code === WS2_PREFLIGHT_ERROR_CODES.WS2_BASELINE_INSUFFICIENT;

  if (!overridable) {
    // Even if an override file exists, it cannot unblock ABSENT /
    // SCHEMA_INVALID — surface the ws-2-scoped rejection.
    return {
      accepted: false,
      code: ws2Scoped.code,
      details: ws2Scoped.details,
      ws1_preflight: ws1Result,
      ws2_scoped: ws2Scoped,
      override: override.present
        ? {
            present: true,
            applied: false,
            valid: override.valid,
            path: override.path,
            ...(override.valid
              ? { override: override.override }
              : { details: override.details }),
            reason:
              'ws-2 override is only honored for UNDERSIZED baselines (AC10.3). ' +
              'ABSENT / SCHEMA_INVALID baselines must be fixed at the source.',
          }
        : { present: false, applied: false },
    };
  }

  // ws-2 baseline is UNDERSIZED. Override may unblock if present + valid.
  if (!override.present) {
    return {
      accepted: false,
      code: ws2Scoped.code,
      details: {
        ...ws2Scoped.details,
        override_available: false,
        override_expected_path: join(projectRoot, WS2_BASELINE_OVERRIDE_RELATIVE_PATH),
      },
      ws1_preflight: ws1Result,
      ws2_scoped: ws2Scoped,
      override: { present: false, applied: false },
    };
  }
  if (!override.valid) {
    return {
      accepted: false,
      code: override.code,
      details: {
        ...override.details,
        underlying_cause: ws2Scoped.code,
        message:
          `ws-2 baseline is UNDERSIZED (${ws2Scoped.code}) and a scoped override ` +
          `is present but INVALID — override rejected: ${override.details.message}`,
      },
      ws1_preflight: ws1Result,
      ws2_scoped: ws2Scoped,
      override: {
        present: true,
        applied: false,
        valid: false,
        path: override.path,
        details: override.details,
      },
    };
  }

  // Override is present + valid → ACCEPT with explicit override audit trail.
  return {
    accepted: true,
    code: 'ACCEPTED_WITH_OVERRIDE',
    details: {
      message:
        'ws-2 Practice-2.4 preflight ACCEPTED via scoped override. ' +
        `Baseline was UNDERSIZED (${ws2Scoped.code}); operator ` +
        `"${override.override.operator}" accepted the risk with rationale: ` +
        `"${override.override.rationale}". Override scope: ${override.override.workstream_id}.`,
      override_path: override.path,
      override_workstream_id: override.override.workstream_id,
      override_effective_at: override.override.effective_at,
    },
    ws1_preflight: ws1Result,
    ws2_scoped: ws2Scoped,
    override: {
      present: true,
      applied: true,
      valid: true,
      path: override.path,
      override: override.override,
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

  let result;
  try {
    result = runWs2Preflight({ projectRoot });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (jsonMode) {
      process.stdout.write(
        JSON.stringify(
          { accepted: false, code: 'UNEXPECTED_ERROR', details: { message } },
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
  } else if (result.accepted) {
    process.stdout.write(
      `ACCEPTED code=${result.code} ` +
        `override_applied=${result.override ? result.override.applied : false}\n`
    );
  } else {
    const detailSummary = JSON.stringify(result.details || {});
    process.stderr.write(`REJECTED ${result.code} ${detailSummary}\n`);
  }

  return result.accepted ? EXIT_ACCEPTED : EXIT_REJECTED;
}

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
