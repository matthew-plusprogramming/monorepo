/**
 * SessionThresholdSnapshot Zod schema.
 *
 * Immutable session-wide capture of per-gate threshold configuration.
 * Written exactly once by `session-checkpoint.mjs start-work` and read by the
 * threshold-reader superset. This schema validates the snapshot
 * shape at the boundary so every downstream consumer receives a known-good
 * object.
 *
 * Contract source: sg-pipeline-efficiency-ws1-convergence-pruning spec.md
 *   §Interfaces & Contracts — Contract: SessionThresholdSnapshot (data-model)
 *
 * Shape (verbatim from contract):
 *   {
 *     per_gate: { [gate_name]: { required_clean_passes: number, captured_at: ISO-8601 } },
 *     source: "hardcoded-default" | "enforcement-flag-advisory" | "enforcement-flag-coercive",
 *     session_started_at: ISO-8601,
 *     immutable: true
 *   }
 *
 * Implements:
 *   REQ-012 (SessionThresholdSnapshot + PerGateThresholdTable)
 *   AC1.1 — accept well-formed snapshot
 *   AC1.2 — reject missing required fields OR `immutable: false`
 *   AC1.3 — reject unknown `source` enum values
 *
 * Non-goals (other atomic specs):
 *   - Snapshot writing (as-005-snapshot-capture)
 *   - Consumer reads (as-008..as-015)
 *   - Immutability enforcement at the write layer (as-006)
 */

import { z } from 'zod';

// ============================================================================
// Enums — Contract source of truth
// ============================================================================

/**
 * Allowed values for `source` per the contract. This tags the provenance of
 * the captured thresholds: hardcoded fallback, advisory-mode flag, or
 * coercive-mode flag. Kept as a module-level export so consumers can reuse
 * the literal set without duplicating strings.
 */
export const SESSION_THRESHOLD_SNAPSHOT_SOURCES = [
  'hardcoded-default',
  'enforcement-flag-advisory',
  'enforcement-flag-coercive',
];

// ============================================================================
// Per-gate entry sub-schema
// ============================================================================

/**
 * Per-gate entry: { required_clean_passes: number, captured_at: ISO-8601 }.
 *
 * `required_clean_passes` is constrained to non-negative integers. `captured_at`
 * is an ISO-8601 datetime string (RFC-3339 profile, via Zod's `.datetime()`).
 *
 * `.strict()` rejects unknown keys so accidental field drift is caught at the
 * boundary.
 */
export const perGateThresholdEntrySchema = z
  .object({
    required_clean_passes: z.number().int().nonnegative(),
    captured_at: z.string().datetime({ offset: true }),
  })
  .strict();

// ============================================================================
// SessionThresholdSnapshot schema
// ============================================================================

/**
 * Full snapshot schema. `per_gate` is modeled as `z.record(string, entry)`
 * because the set of gate names is owned by the PerGateThresholdTable contract
 * (see as-002 / spec.md §Contract: PerGateThresholdTable), not by the snapshot
 * shape itself. Keeping the key type open here avoids duplicating the enum
 * and lets the table-owner evolve the gate set without amending this schema.
 *
 * `immutable: z.literal(true)` enforces the contract's `const: true` — any
 * snapshot must self-identify as immutable; `immutable: false` is a structural
 * rejection (AC1.2).
 */
export const sessionThresholdSnapshotSchema = z
  .object({
    per_gate: z.record(z.string().min(1), perGateThresholdEntrySchema),
    source: z.enum(SESSION_THRESHOLD_SNAPSHOT_SOURCES),
    session_started_at: z.string().datetime({ offset: true }),
    immutable: z.literal(true),
  })
  .strict();

// ============================================================================
// Parse helper — discriminated-union return
// ============================================================================

/**
 * Parse and validate a SessionThresholdSnapshot value.
 *
 * Mirrors the `parseManifest()` helper pattern in deployment-manifest-schema.mjs
 * so consumers can branch on `.success` without pulling in Zod directly.
 *
 * @param {unknown} data — candidate snapshot
 * @returns {{ success: true, data: object } | { success: false, error: import('zod').ZodError }}
 */
export function parseSessionThresholdSnapshot(data) {
  const result = sessionThresholdSnapshotSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
