/**
 * Reverse-governance audit-entry helper — typed delegate around the audit
 * writer with `decision_type` pinned.
 *
 * Owner doc: .claude/docs/RTC-ENFORCEMENT-AUDIT.md.
 * Requirements: REQ-NFR-025 (chain consistency), AC-012 / BIZ-008
 *   (reverse-governance audit trail).
 *
 * Operational SLA: 10 business days from trigger to logged decision
 * (documentation-only, NOT automated — parent Non-goal). This helper exists
 * to give ops scripts an explicit, discoverable surface and to centralise the
 * decision_type literal. Validation lives exclusively on the writer side
 * (AuditLogEntrySchema via appendEntry).
 *
 * @see ../../docs/RTC-ENFORCEMENT-AUDIT.md
 */

import { appendEntry } from './enforcement-audit-writer.mjs';

/**
 * Append a reverse-governance decision entry to the enforcement audit log.
 *
 * @param {{
 *   outcome: 'accepted' | 'rejected' | 'deferred' | 'withdrawn',
 *   trigger: string,
 *   rationale: string,
 *   operator: string,
 *   logPath?: string,
 * }} params
 * @returns {Record<string, unknown>} The appended entry.
 */
export function appendReverseGovernanceEntry(params) {
  const { logPath, ...rest } = params ?? {};
  return appendEntry(
    {
      decision_type: 'reverse-governance',
      ...rest,
    },
    { logPath },
  );
}
