/**
 * Attestation-Skip Decision Helper.
 *
 * Implements the attestation-skip branch of `deriveConvergenceFromEvidence()`
 * for content-stable convergence gates (REQ-001, Phase D / Tasks D2+D3, EC-7).
 *
 * Behavior (per spec §Phase-D, §Flow-4, §EC-7):
 *
 *   1. If the gate's `PerGateThresholdTable` entry carries
 *      `attestation_mode: "content-hash"` AND the latest clean pass's
 *      persisted `content_hash` equals the prior clean pass's
 *      `content_hash`, the gate SHALL mark converged at 1 clean pass
 *      + attestation. Pass N+1 is NOT scheduled.
 *
 *   2. If the content-hash differs between the two clean passes, the
 *      system SHALL fall back to the `required_clean_passes` consecutive
 *      clean passes rule (EC-7 conservative false-positive).
 *
 *   3. Gates with `attestation_mode: "timestamp"` or `"none"` SHALL use the
 *      plain consecutive-clean-pass rule unchanged (AC13.4).
 *
 * Contract: this module is PURE. It reads `PerGateThresholdTable` (a
 * frozen, module-load constant) and inspects pass records passed by the
 * caller. It performs no filesystem I/O, no network calls, and never
 * mutates its inputs. The content-hash on each pass is written at
 * `recordPass()` time (session-checkpoint.mjs); this helper only compares
 * already-persisted values.
 *
 * Gate-name translation: callers pass consumer-short gate names (the
 * names stored in `session.convergence_evidence[<gate>]`). This module
 * maps them to the canonical `PerGateThresholdTable` keys via
 * `CONSUMER_TO_TABLE_GATE` -- same mapping as
 * `lib/snapshot-threshold-reader.mjs CONSUMER_TO_SNAPSHOT_GATE`.
 *
 * Implements: REQ-001 (AC13.1, AC13.3, AC13.4)
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning / as-013
 * Consumer: `.claude/scripts/session-checkpoint.mjs` opUpdateConvergence
 */

import { PerGateThresholdTable } from './per-gate-threshold-table.mjs';

// =============================================================================
// Constants
// =============================================================================

/**
 * Consumer-short gate name -> canonical PerGateThresholdTable key.
 *
 * Kept byte-identical in spirit to `CONSUMER_TO_SNAPSHOT_GATE` in
 * `lib/snapshot-threshold-reader.mjs`. Duplicating the mapping here (rather
 * than importing) keeps this module self-contained and avoids a cross-lib
 * dependency cycle: snapshot-threshold-reader has no reason to import
 * attestation-skip, and vice-versa.
 *
 * An unknown consumer-short name resolves to `null` and the helper returns
 * "no skip" -- conservative fallback (AC13.3 semantics extended to unknown
 * gates).
 *
 * @type {Readonly<Record<string, string>>}
 */
const CONSUMER_TO_TABLE_GATE = Object.freeze({
  investigation: 'investigation',
  challenger: 'challenger-pre-impl',
  'challenger-pre-impl': 'challenger-pre-impl',
  'challenger-pre-orch': 'challenger-pre-orch',
  code_review: 'code-review',
  'code-review': 'code-review',
  security_review: 'security',
  security: 'security',
  unifier: 'unifier',
  completion_verifier: 'completion-verifier',
  'completion-verifier': 'completion-verifier',
});

/**
 * Attestation-skip decision outcomes returned by `shouldSkipForAttestation()`.
 *
 * - `skip`    -- attestation matched: mark converged at 1 clean + attestation
 *                (AC13.1). Caller MUST NOT require a further pass for this
 *                gate.
 * - `no-skip` -- attestation did not match (EC-7 fallback, AC13.3), OR the
 *                gate is not configured for content-hash attestation
 *                (AC13.4), OR insufficient pass evidence to compare. Caller
 *                SHALL continue using the `required_clean_passes` rule.
 *
 * @type {Readonly<{ SKIP: 'skip', NO_SKIP: 'no-skip' }>}
 */
export const ATTESTATION_DECISION = Object.freeze({
  SKIP: 'skip',
  NO_SKIP: 'no-skip',
});

// =============================================================================
// Public API
// =============================================================================

/**
 * Look up the canonical `PerGateThresholdTable` entry for a consumer-short
 * gate name. Returns `null` when the gate is unknown or the table has no
 * entry (defensive -- the table is frozen at module load so missing entries
 * would be a programmer error, not a runtime input).
 *
 * Exposed for tests and for `recordPass()` in session-checkpoint.mjs, which
 * needs the same lookup to decide whether to compute + persist a
 * content-hash at pass-record time.
 *
 * @param {string} consumerGateName
 * @returns {Readonly<{ required_clean_passes: number, attestation_mode: 'content-hash' | 'timestamp' | 'none', hash_input_manifest: readonly string[], rationale?: string }> | null}
 */
export function resolveTableEntryForGate(consumerGateName) {
  const canonical = CONSUMER_TO_TABLE_GATE[consumerGateName];
  if (!canonical) return null;
  const entry = PerGateThresholdTable[canonical];
  if (!entry || typeof entry !== 'object') return null;
  return entry;
}

/**
 * Whether a gate is configured for content-hash attestation.
 *
 * Convenience wrapper around `resolveTableEntryForGate` -- used by
 * `recordPass()` to decide whether to compute + persist a content-hash on
 * each new pass evidence record (AC13.2). Gates with attestation_mode of
 * `"none"` or `"timestamp"` skip the computation entirely to avoid
 * unnecessary filesystem reads.
 *
 * @param {string} consumerGateName
 * @returns {boolean}
 */
export function gateUsesContentHashAttestation(consumerGateName) {
  const entry = resolveTableEntryForGate(consumerGateName);
  return Boolean(entry && entry.attestation_mode === 'content-hash');
}

/**
 * Decide whether a gate may be marked converged under the attestation-skip
 * rule given the current pass history.
 *
 * AC13.1: If attestation_mode is `"content-hash"` AND the latest eligible
 * clean pass's `content_hash` equals the prior eligible clean pass's
 * `content_hash`, return `ATTESTATION_DECISION.SKIP`.
 *
 * AC13.3 (EC-7): If the two latest clean passes carry different content
 * hashes, OR one/both are missing a `content_hash` field, return
 * `ATTESTATION_DECISION.NO_SKIP`.
 *
 * AC13.4: If attestation_mode is not `"content-hash"` (i.e. `"timestamp"`
 * or `"none"`), return `ATTESTATION_DECISION.NO_SKIP` -- plain consecutive
 * counting applies.
 *
 * "Eligible clean pass" here means: the pass record object is non-null,
 * has `clean === true`, and is in the final contiguous clean streak from
 * the tail. We walk backwards from the last record; the first non-clean
 * record terminates the scan (a dirty run breaks the streak and kills any
 * possibility of "two consecutive clean passes with matching hash" --
 * EC-7 fallback applies).
 *
 * The helper does NOT read the session's threshold snapshot. The snapshot
 * carries `required_clean_passes`, which the caller compares separately;
 * this helper only answers the orthogonal question "can we short-circuit
 * to 1-clean-plus-attestation?"
 *
 * @param {string} consumerGateName - e.g., 'unifier', 'code_review'.
 * @param {Array<object>|null|undefined} passes - session.convergence_evidence[gate].passes
 * @returns {{ decision: 'skip' | 'no-skip', reason: string, matched_hash?: string }}
 *   `decision`: ATTESTATION_DECISION value. `reason` is a short stable
 *   string suitable for structured logging (see caller in
 *   session-checkpoint.mjs). `matched_hash` is populated only when
 *   decision=skip, carrying the content-hash that attested the gate.
 */
export function shouldSkipForAttestation(consumerGateName, passes) {
  const entry = resolveTableEntryForGate(consumerGateName);

  // AC13.4 -- unknown gate or non-content-hash mode: no skip.
  if (!entry) {
    return { decision: ATTESTATION_DECISION.NO_SKIP, reason: 'unknown_gate' };
  }
  if (entry.attestation_mode !== 'content-hash') {
    return {
      decision: ATTESTATION_DECISION.NO_SKIP,
      reason: `attestation_mode_${entry.attestation_mode}`,
    };
  }

  if (!Array.isArray(passes) || passes.length < 2) {
    // Need at least two passes (Pass N and Pass N-1) to compare.
    return {
      decision: ATTESTATION_DECISION.NO_SKIP,
      reason: 'insufficient_pass_history',
    };
  }

  // Walk from the tail to resolve Pass N (latest non-null record) and
  // Pass N-1 (the next non-null record before it). Non-object / null
  // entries are skipped defensively (malformed records should never
  // appear but would otherwise break the comparison silently).
  /** @type {object[]} */
  const tailRecords = [];
  for (let i = passes.length - 1; i >= 0; i--) {
    const record = passes[i];
    if (!record || typeof record !== 'object') continue;
    tailRecords.push(record);
    if (tailRecords.length >= 2) break;
  }

  if (tailRecords.length < 2) {
    return {
      decision: ATTESTATION_DECISION.NO_SKIP,
      reason: 'insufficient_pass_history',
    };
  }

  const latest = tailRecords[0];
  const prior = tailRecords[1];

  // AC13.1 precondition: "mark converged at 1 clean + attestation" --
  // Pass N (latest) MUST be clean to be a candidate for convergence.
  // Pass N-1's clean flag is not required by the spec wording; only its
  // content_hash is compared. This matches §REQ-001 literally and EC-7's
  // expectation that a dirty Pass N-1 followed by a clean Pass N with
  // stable content can still trigger the skip (the input bytes did not
  // change between the two runs).
  if (latest.clean !== true) {
    return {
      decision: ATTESTATION_DECISION.NO_SKIP,
      reason: 'latest_pass_not_clean',
    };
  }

  const latestHash = latest.content_hash;
  const priorHash = prior.content_hash;

  // EC-7: missing hash on either side -> fall back to consecutive counting.
  // A missing hash is distinct from "equal" and distinct from "differ" --
  // we conservatively treat it as "no attestation available" so the gate
  // reverts to `required_clean_passes` consecutive clean passes.
  if (typeof latestHash !== 'string' || latestHash.length === 0) {
    return {
      decision: ATTESTATION_DECISION.NO_SKIP,
      reason: 'latest_content_hash_missing',
    };
  }
  if (typeof priorHash !== 'string' || priorHash.length === 0) {
    return {
      decision: ATTESTATION_DECISION.NO_SKIP,
      reason: 'prior_content_hash_missing',
    };
  }

  if (latestHash === priorHash) {
    // AC13.1 -- attestation: content-stable across the two most recent
    // clean passes.
    return {
      decision: ATTESTATION_DECISION.SKIP,
      reason: 'content_hash_stable',
      matched_hash: latestHash,
    };
  }

  // AC13.3 / EC-7 -- content changed between passes: conservative
  // fallback, no skip.
  return {
    decision: ATTESTATION_DECISION.NO_SKIP,
    reason: 'content_hash_changed',
  };
}
