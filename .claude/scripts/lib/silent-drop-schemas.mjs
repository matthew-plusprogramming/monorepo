/**
 * Silent-Drop Observability Zod Schemas
 *
 * Central schema module for all silent-drop observability data-model contracts:
 *
 *   - silentDropChecklistAnswerSchema (AC-8, AC-13)
 *   - silentDropEnforcementFlagSchema (AC-5, AC-11)
 *   - silentDropBaselineReportSchema (AC-5, AC-17, NFR-16)
 *   - silentDropAuditLogEntrySchema (AC-16, NFR-10)
 *   - reengagementHistoryEntrySchema (AC-20.3)
 *
 * Validation lives at boundaries: parsers, writers, verifiers. Consumers:
 *   - parse-review-silent-drop-checklist.mjs (checklist answer)
 *   - verify-enforcement-audit-chain.mjs (audit entry + baseline)
 *   - silent-drop-baseline-sla-monitor.mjs (reengagement append)
 *   - silent-drop-coercive-flip-preflight.mjs (flag read + baseline gate)
 *
 * Implements: AC-5.2, AC-5.3, AC-5.4, AC-8.4, AC-16.6, AC-20.3
 */

import { z } from 'zod';

// =============================================================================
// Shared primitives
// =============================================================================

/** ISO-8601 UTC timestamp string. */
export const iso8601UtcSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, {
    message: 'must be ISO-8601 UTC (Z suffix)',
  });

/** UUIDv4 string (used for entry_id, correlation_id). */
export const uuidV4Schema = z.string().uuid();

/** SHA-256 hex digest (64 lowercase hex chars). */
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: 'must be 64 lowercase hex chars (SHA-256 hex)',
});

// =============================================================================
// SilentDropChecklistAnswer (parser input + code-reviewer output block)
// =============================================================================

/** Kinds of Category H findings code-reviewer may emit. */
export const FINDING_KINDS = [
  'missing-log',
  'missing-metric',
  'free-form-reason',
  'label-cardinality',
  'sensitive-reason-value',
  'annotation-overuse',
  'annotation-stale',
  'metric-naming-violation',
];

export const findingSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().nonnegative(),
    kind: z.enum(FINDING_KINDS),
  })
  .strict();

export const advisorySuspectSchema = z
  .object({
    file: z.string().min(1),
    // REQ-NFR-13: function_name truncated to ≤40 chars
    function_name: z.string().max(40),
    line: z.number().int().nonnegative(),
    reason: z.literal('skip-without-observability'),
  })
  .strict();

export const annotationUsedSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().nonnegative(),
    suppressed: z.array(z.string()).min(1),
    // REQ-NFR-14: rationale_prefix = first 40 plain-text chars
    rationale_prefix: z.string().max(40),
  })
  .strict();

export const truncationSchema = z
  .object({
    count_omitted: z.number().int().nonnegative(),
    reason: z.enum(['findings-cap-50', 'advisory-suspects-cap-100']),
  })
  .strict();

/** SilentDropChecklistAnswer — emitted by code-reviewer, consumed by parser. */
export const silentDropChecklistAnswerSchema = z
  .object({
    applied: z.boolean(),
    delivery_path_modules_touched: z.array(z.string()),
    // NFR-9 cap enforcement happens at writer side; schema validates shape only.
    findings: z.array(findingSchema).max(50),
    advisory_suspects: z.array(advisorySuspectSchema).max(100),
    annotations_used: z.array(annotationUsedSchema),
    truncation: truncationSchema.optional(),
  })
  .strict();

// =============================================================================
// SilentDropEnforcementFlag (operator-controlled flag; agent write blocked)
// =============================================================================

export const enforcementModeSchema = z.enum(['advisory', 'coercive', 'off']);

/** SilentDropEnforcementFlag — `.claude/config/silent-drop-enforcement.json`. */
export const silentDropEnforcementFlagSchema = z
  .object({
    mode: enforcementModeSchema,
    // EDGE-004: effective_at bounded to [now-5min, now+24h] — bounds
    // checked at write time, not schema time (needs current clock).
    effective_at: iso8601UtcSchema,
    operator: z.string().min(1),
    correlation_id: uuidV4Schema,
    schema_version: z.literal('1.0'),
  })
  .strict();

// =============================================================================
// Reengagement history entry (AC-20.3)
// =============================================================================

export const reengagementDecisionSchema = z.enum([
  'extend-revert-90d',
  'attempt-coercive-flip',
  'kill-gate-terminal',
]);

export const reengagementHistoryEntrySchema = z
  .object({
    date: iso8601UtcSchema,
    decision: reengagementDecisionSchema,
    // AC-20.3: rationale ≥30 chars
    rationale: z.string().min(30),
  })
  .strict();

// =============================================================================
// SilentDropBaselineReport (gates coercive flip; NFR-16 statistical integrity)
// =============================================================================

export const operatorDecisionSchema = z.enum([
  'scope-narrow',
  'budget-tune',
  'revert-advisory',
  'kill-gate',
  'flip-coercive',
  'extend-window',
]);

export const measurementWindowSchema = z
  .object({
    start: iso8601UtcSchema,
    end: iso8601UtcSchema,
  })
  .strict();

/** SilentDropBaselineReport — `.claude/metrics/silent-drop-baseline.json`. */
export const silentDropBaselineReportSchema = z
  .object({
    schema_version: z.literal('1.0'),
    measurement_window: measurementWindowSchema,
    sample_floor_met: z.boolean(),
    sample_floor_waived: z.boolean(),
    // AC-5.2: waiver rationale ≥50 chars when waived=true.
    // Business rule enforced at refine() level below (requires cross-field check).
    waiver_rationale: z.string().optional(),
    // NFR-16(a): excludes truncated PRs
    sample_count: z.number().int().nonnegative(),
    // NFR-16(b): per-PR contribution capped at 10 findings (enforced by writer)
    advisory_findings_emitted: z.number().int().nonnegative(),
    true_positive_count: z.number().int().nonnegative(),
    false_positive_count: z.number().int().nonnegative(),
    false_positive_rate: z.number().min(0).max(1).nullable(),
    catch_rate: z.number().min(0).max(1).nullable(),
    context_engine_replay_pass: z.boolean(),
    operator_decision: operatorDecisionSchema,
    decision_rationale: z.string(),
    // AC-20.1: effective_at drives the 90-day reengagement clock when
    // operator_decision=revert-advisory.
    effective_at: iso8601UtcSchema.optional(),
    // AC-22.3: published_substrate captures the CODEOWNERS substrate at
    // baseline publication time; preflight warns if substrate changes.
    published_substrate: z
      .enum(['github-branch-protection', 'local-single-maintainer', 'other'])
      .optional(),
    reengagement_history: z.array(reengagementHistoryEntrySchema),
    // NFR-16(c): ≥3 distinct PR authors
    distinct_authors_count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Zero-sample semantics: when sample_count=0, rates must be null. This
    // is a structural consistency check.
    if (data.sample_count === 0) {
      if (data.false_positive_rate !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['false_positive_rate'],
          message: 'must be null when sample_count=0',
        });
      }
      if (data.catch_rate !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['catch_rate'],
          message: 'must be null when sample_count=0',
        });
      }
    }
    // NOTE: AC-5.2 waiver_rationale ≥50 chars rule is NOT enforced here.
    // It is a gate-level business rule checked by the coercive-flip preflight
    // so failures emit the spec-named code `waiver-rationale-too-short`
    // rather than a generic `baseline-invalid`.
  });

// =============================================================================
// SilentDropAuditLogEntry (hash-chained; security-tagged)
// =============================================================================

export const entryKindSchema = z.enum(['normal', 're-genesis', 'quarantine']);

export const anomalyKindSchema = z.enum([
  'hash-mismatch',
  'tampered-signature',
  'missing-entry',
]);

// Base fields common to every entry kind.
const baseAuditEntry = {
  entry_id: uuidV4Schema,
  timestamp: iso8601UtcSchema,
  operator: z.string().min(1),
  signature: z.string().min(1),
};

export const normalAuditEntrySchema = z
  .object({
    ...baseAuditEntry,
    entry_kind: z.literal('normal'),
    // Genesis has null; subsequent normals are 64-char hex
    prev_hash: z.union([z.null(), sha256HexSchema]),
    correlation_id: uuidV4Schema,
    mode: enforcementModeSchema,
    effective_at: iso8601UtcSchema,
  })
  .strict();

export const quarantineAuditEntrySchema = z
  .object({
    ...baseAuditEntry,
    entry_kind: z.literal('quarantine'),
    // Quarantine entries restart the local chain semantically; the
    // `last_valid_prev_hash` field is the identity anchor (EC-16(g)).
    prev_hash: z.null(),
    correlation_id: z.null(),
    last_valid_prev_hash: sha256HexSchema,
    detected_anomaly_kind: anomalyKindSchema,
  })
  .strict();

export const reGenesisAuditEntrySchema = z
  .object({
    ...baseAuditEntry,
    entry_kind: z.literal('re-genesis'),
    // Re-genesis restarts the chain
    prev_hash: z.null(),
    correlation_id: z.null(),
    quarantine_ref: uuidV4Schema,
  })
  .strict();

/** SilentDropAuditLogEntry — discriminated union over entry_kind. */
export const silentDropAuditLogEntrySchema = z.discriminatedUnion('entry_kind', [
  normalAuditEntrySchema,
  quarantineAuditEntrySchema,
  reGenesisAuditEntrySchema,
]);
