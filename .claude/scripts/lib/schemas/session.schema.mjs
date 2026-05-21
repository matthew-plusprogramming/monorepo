/**
 * Session-wide Zod schema registration.
 *
 * This module is the aggregation point for session.json Zod sub-schemas.
 * At present it registers:
 *   - `session.active_work.threshold_snapshot` (optional) — validated against
 *     `sessionThresholdSnapshotSchema` from ./session-threshold-snapshot.schema.mjs
 *
 * Scope
 * -----
 * This file is intentionally NOT a full validator for every field of
 * session.json — that responsibility lives with
 * `.claude/specs/schema/session.schema.json` (JSON Schema, loaded by
 * `.claude/scripts/session-validate.mjs`). The Zod module here exists so new
 * session-payload contracts landing under sg-pipeline-efficiency-ws1-convergence-pruning
 * (and successor specs) can enforce shape at the write boundary without a
 * round-trip through the JSON-Schema validator. Additional sub-schemas will
 * register here as companion specs land (PerGateThresholdTable consumption,
 * enforcement-flag advisory, etc.).
 *
 * Public API
 * ----------
 *   - `sessionThresholdSnapshotSchema` — re-export of the Zod schema
 *   - `activeWorkThresholdSnapshotOnlySchema` — lightweight object validator that
 *     targets only `active_work.threshold_snapshot` (present → validated,
 *     absent → passthrough). This is the AC1.4 surface.
 *   - `validateActiveWorkThresholdSnapshot(sessionLike)` — convenience helper
 *     that reaches into a session-shaped object and runs the snapshot schema
 *     when the field is present. Returns the same discriminated-union shape
 *     as `parseSessionThresholdSnapshot()`.
 *
 * Implements:
 *   REQ-012 (schema-layer obligation)
 *   AC1.4 — sub-schema applied to `session.active_work.threshold_snapshot` when present
 */

import { z } from 'zod';
import {
  sessionThresholdSnapshotSchema,
  parseSessionThresholdSnapshot,
} from './session-threshold-snapshot.schema.mjs';

// ============================================================================
// Re-exports
// ============================================================================

/**
 * Re-export the snapshot schema so downstream modules have a single import
 * target (`session.schema.mjs`) per the shipped registration contract.
 */
export {
  sessionThresholdSnapshotSchema,
  parseSessionThresholdSnapshot,
};

// ============================================================================
// Active-work slice schema — threshold_snapshot only
// ============================================================================

/**
 * Partial validator targeting the `active_work.threshold_snapshot` path.
 *
 * Intentionally permissive on every other `active_work` field: this module
 * owns ONLY the snapshot sub-shape. When the snapshot key is absent, the
 * object passes through unchanged (AC1.4: "when present"). When it is
 * present, it MUST conform to `sessionThresholdSnapshotSchema`.
 *
 * `.passthrough()` preserves unmodeled sibling fields so this schema can be
 * composed into a larger session-wide validator later without dropping data.
 */
export const activeWorkThresholdSnapshotOnlySchema = z
  .object({
    threshold_snapshot: sessionThresholdSnapshotSchema.optional(),
  })
  .passthrough();

/**
 * Outer session-shaped validator — exposes the `active_work` slot and nothing
 * else. Callers passing a full session object get a passthrough for every
 * field except `active_work.threshold_snapshot`, which is shape-checked.
 */
export const sessionThresholdSnapshotRegistrationSchema = z
  .object({
    active_work: activeWorkThresholdSnapshotOnlySchema.nullable().optional(),
  })
  .passthrough();

// ============================================================================
// Convenience helper
// ============================================================================

/**
 * Validate the `active_work.threshold_snapshot` slot of a session-shaped
 * object.
 *
 * Semantics (AC1.4):
 *   - session has no `active_work`            → { success: true, data: undefined }
 *   - active_work has no `threshold_snapshot` → { success: true, data: undefined }
 *   - snapshot present and well-formed        → { success: true, data: <snapshot> }
 *   - snapshot present but malformed          → { success: false, error: ZodError }
 *
 * @param {unknown} sessionLike — a session.json-shaped object
 * @returns {{ success: true, data: object | undefined } | { success: false, error: import('zod').ZodError }}
 */
export function validateActiveWorkThresholdSnapshot(sessionLike) {
  const outer = sessionThresholdSnapshotRegistrationSchema.safeParse(sessionLike);
  if (!outer.success) {
    return { success: false, error: outer.error };
  }
  const snapshot = outer.data?.active_work?.threshold_snapshot;
  if (snapshot === undefined) {
    return { success: true, data: undefined };
  }
  return parseSessionThresholdSnapshot(snapshot);
}
