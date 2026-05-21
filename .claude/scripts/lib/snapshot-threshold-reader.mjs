/**
 * Snapshot Threshold Reader — consumer-side helper.
 *
 * Reads per-gate `required_clean_passes` from
 * `session.active_work.threshold_snapshot.per_gate[gate]` with graceful
 * degradation when the snapshot is absent (pre-as-005 sessions) or malformed.
 *
 * This is the canonical read path for Phase-C consumers (as-007..as-011). It
 * translates consumer-side "short" gate names (the names used by enforcement
 * prerequisites and manifest/session convergence records) into the canonical
 * `PerGateThresholdTable` gate keys and returns the snapshot's
 * `required_clean_passes` value, falling back to the caller-provided default
 * when any step of the lookup fails.
 *
 * Contract source:
 *   sg-pipeline-efficiency-ws1-convergence-pruning / spec.md
 *   §Interfaces & Contracts — Contract: SessionThresholdSnapshot (data-model)
 *   §Contract: contract-threshold-reader-superset-8 (Phase-C consumers)
 *
 * Gate-name translation (consumer-short → snapshot-canonical):
 *   investigation       → investigation
 *   challenger          → challenger-pre-impl   (default substage; see below)
 *   code_review         → code-review
 *   security_review     → security
 *   unifier             → unifier
 *   completion_verifier → completion-verifier
 *
 * Rationale for `challenger → challenger-pre-impl`:
 *   The enforcement prerequisite set for `implementer` checks
 *   `session.convergence.challenger.clean_pass_count` — a single aggregated
 *   counter that reflects the pre-implementation stage (the only challenger
 *   stage gating implementer dispatch).
 *
 * Implements:
 *   REQ-012 — snapshot reader pattern (consumers 3-4 of 8: hook enforcement pair)
 *   AC7.4 / AC8.3 — graceful fallback when snapshot absent or malformed
 *   NFR-16 — threshold-consumer invariants: value reads are data-driven, no
 *           inline `=== 2` / `>= 2` at the consumer call site.
 */

// ============================================================================
// Constants — gate-name mapping
// ============================================================================

/**
 * Consumer-short gate name → snapshot-canonical gate key.
 *
 * Frozen at module-load. Callers that pass a gate name not in this map
 * receive the fallback value (treated as "unknown gate, degrade gracefully").
 *
 * @type {Readonly<Record<string, string>>}
 */
const CONSUMER_TO_SNAPSHOT_GATE = Object.freeze({
  investigation: 'investigation',
  challenger: 'challenger-pre-impl',
  'challenger-pre-impl': 'challenger-pre-impl',
  code_review: 'code-review',
  'code-review': 'code-review',
  security_review: 'security',
  security: 'security',
  unifier: 'unifier',
  completion_verifier: 'completion-verifier',
  'completion-verifier': 'completion-verifier',
});

// ============================================================================
// Reader
// ============================================================================

/**
 * Read `required_clean_passes` for a gate from the session snapshot.
 *
 * Returns the fallback value when any of the following hold:
 *   - `session` is null/undefined or non-object.
 *   - `session.active_work.threshold_snapshot` is absent.
 *   - The snapshot's `per_gate` sub-object is absent or non-object.
 *   - The consumer-short gate name has no canonical mapping.
 *   - The snapshot entry for the canonical gate is absent.
 *   - The entry's `required_clean_passes` is not a positive integer.
 *
 * The reader NEVER throws. Any structural issue results in a silent fallback
 * to preserve the hook layer's fail-open posture.
 *
 * @param {object|null|undefined} session - Session object from session.json
 * @param {string} consumerGateName - Consumer-short gate name (e.g., 'investigation')
 * @param {number} fallback - Value to return when snapshot read fails (typically
 *                            REQUIRED_CLEAN_PASSES from workflow-dag.mjs = 2)
 * @returns {number} required_clean_passes from snapshot, or fallback
 */
export function readThresholdFromSnapshot(session, consumerGateName, fallback) {
  // Fallback must itself be a safe number; degrade to 2 if caller passes junk.
  const safeFallback =
    Number.isInteger(fallback) && fallback >= 1 ? fallback : 2;

  if (!session || typeof session !== 'object') {
    return safeFallback;
  }

  const snapshot = session.active_work?.threshold_snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    // AC7.4 / AC8.3: pre-as-005 session or malformed snapshot → fallback.
    return safeFallback;
  }

  const perGate = snapshot.per_gate;
  if (!perGate || typeof perGate !== 'object') {
    return safeFallback;
  }

  const canonicalGate = CONSUMER_TO_SNAPSHOT_GATE[consumerGateName];
  if (!canonicalGate) {
    return safeFallback;
  }

  const entry = perGate[canonicalGate];
  if (!entry || typeof entry !== 'object') {
    return safeFallback;
  }

  const value = entry.required_clean_passes;
  if (!Number.isInteger(value) || value < 1) {
    return safeFallback;
  }

  return value;
}

/**
 * Whether the session has a captured snapshot.
 *
 * Presence check only — does not validate shape beyond `per_gate` being a
 * non-null object. Used by consumers that want to branch on "graceful
 * degradation vs. data-driven" without performing a full read.
 *
 * @param {object|null|undefined} session
 * @returns {boolean}
 */
export function hasSnapshot(session) {
  if (!session || typeof session !== 'object') return false;
  const snapshot = session.active_work?.threshold_snapshot;
  if (!snapshot || typeof snapshot !== 'object') return false;
  const perGate = snapshot.per_gate;
  return Boolean(perGate && typeof perGate === 'object');
}
