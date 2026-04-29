/**
 * AuditLogEntry discriminated-union Zod schema + parseEntry helper.
 *
 * Owner doc: .claude/docs/RTC-ENFORCEMENT-AUDIT.md
 *       (AuditLogEntry data-model)
 * Requirements: REQ-NFR-025 (tamper resistance), REQ-NFR-015 (mode-change
 *   variant), AC-012 / BIZ-008 (reverse-governance variant).
 *
 * Five discriminated-union variants keyed on `decision_type`:
 *   - mode-change                    (REQ-NFR-015)
 *   - credential-rotation-start      (F-002 audit-entry reconciliation)
 *   - credential-rotation-end        (F-002)
 *   - reverse-governance             (AC-012 / BIZ-008)
 *   - quarantine                     (EDGE-FA-13 recovery)
 *
 * Each variant .strict() — unknown keys are rejected (AC4.8).
 *
 * Common base fields (inlined per variant so `.strict()` applies uniformly):
 *   decision_type  — discriminator literal
 *   prev_hash      — 64-char lowercase hex SHA-256 (AC4.9)
 *   timestamp      — ISO-8601 datetime
 *   operator       — non-empty string
 */

import { z } from 'zod';

/** 64-char lowercase hex SHA-256 — enforces AC4.9 (prev_hash constraint). */
const lowercaseHex64 = z.string().regex(/^[0-9a-f]{64}$/);

const datetime = z.string().datetime({ offset: true });
const nonEmptyString = z.string().min(1);

const modeChangeSchema = z
  .object({
    decision_type: z.literal('mode-change'),
    prev_hash: lowercaseHex64,
    timestamp: datetime,
    operator: nonEmptyString,
    mode: z.enum(['advisory', 'coercive', 'off']),
    effective_at: datetime,
  })
  .strict();

const credentialRotationStartSchema = z
  .object({
    decision_type: z.literal('credential-rotation-start'),
    prev_hash: lowercaseHex64,
    timestamp: datetime,
    operator: nonEmptyString,
    credential_ref: nonEmptyString,
    overlap_window_start: datetime,
    overlap_window_end: datetime,
  })
  .strict();

const credentialRotationEndSchema = z
  .object({
    decision_type: z.literal('credential-rotation-end'),
    prev_hash: lowercaseHex64,
    timestamp: datetime,
    operator: nonEmptyString,
    credential_ref: nonEmptyString,
    rotation_completed_at: datetime,
  })
  .strict();

const reverseGovernanceSchema = z
  .object({
    decision_type: z.literal('reverse-governance'),
    prev_hash: lowercaseHex64,
    timestamp: datetime,
    operator: nonEmptyString,
    outcome: z.enum(['accepted', 'rejected', 'deferred', 'withdrawn']),
    trigger: nonEmptyString,
    rationale: nonEmptyString,
  })
  .strict();

const quarantineSchema = z
  .object({
    decision_type: z.literal('quarantine'),
    prev_hash: lowercaseHex64,
    timestamp: datetime,
    operator: nonEmptyString,
    quarantined_file_sha256: lowercaseHex64,
    quarantine_reason: nonEmptyString,
  })
  .strict();

/**
 * Discriminated union over `decision_type`. Zod refuses unknown discriminator
 * values with an `invalid_union_discriminator` issue citing the path
 * (AC4.7 — test asserts on `decision_type|discriminator`).
 */
export const AuditLogEntrySchema = z.discriminatedUnion('decision_type', [
  modeChangeSchema,
  credentialRotationStartSchema,
  credentialRotationEndSchema,
  reverseGovernanceSchema,
  quarantineSchema,
]);

/**
 * Validate an entry object against the union.
 *
 * @param {unknown} obj - Parsed entry object (NOT raw JSON string).
 * @returns {{success: true, data: any}
 *           | {success: false, error: {code: "ENTRY_VALIDATION_FAILED", message: string, issues: any[]}}}
 */
export function parseEntry(obj) {
  const result = AuditLogEntrySchema.safeParse(obj);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: {
      code: 'ENTRY_VALIDATION_FAILED',
      message: 'AuditLogEntry schema validation failed',
      issues: result.error.issues,
    },
  };
}
