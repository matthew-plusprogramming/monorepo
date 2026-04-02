/**
 * Self-resolution return payload sideband construction utility.
 *
 * Builds the self_resolutions sideband field for agent return payloads.
 * Handles the 10-entry cap with tier-based retention and emits
 * research_depth_warning when reasoning-tier exceeds 30%.
 *
 * Spec: sg-self-answering-agents (Tasks 11-12)
 * ACs: AC-5.1, AC-5.2, AC-5.3, AC-5.4, AC-5.5, AC-5.6
 */

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of self-resolution entries in the sideband. */
const MAX_SIDEBAND_ENTRIES = 10;

/** Reasoning tier integer value. */
const REASONING_TIER = 4;

/** Threshold for research depth warning (>30%). */
const REASONING_TIER_WARNING_THRESHOLD = 0.30;

// =============================================================================
// Payload Construction
// =============================================================================

/**
 * Build the return payload with self_resolutions sideband field.
 *
 * Preserves all existing base payload fields and adds:
 * - self_resolutions: Array of resolution entries (capped at 10, tier-prioritized)
 * - self_resolutions_truncated: Count of dropped entries (0 if <= 10)
 * - research_depth_warning: Warning string if reasoning-tier > 30%, null otherwise
 *
 * @param {object} basePayload - The base agent return payload (status, summary, blockers, artifacts)
 * @param {Array<object>} resolutions - Array of self-resolution entries with tier (1-4) field
 * @returns {object} Enhanced payload with sideband fields
 */
export function buildReturnPayload(basePayload, resolutions) {
  const allResolutions = resolutions || [];
  const totalCount = allResolutions.length;

  // Tier-based retention: sort by tier ascending (lower tier = higher priority)
  // Then take the top MAX_SIDEBAND_ENTRIES
  const sorted = [...allResolutions].sort((a, b) => a.tier - b.tier);
  const retained = sorted.slice(0, MAX_SIDEBAND_ENTRIES);
  const truncatedCount = Math.max(0, totalCount - MAX_SIDEBAND_ENTRIES);

  // Calculate research depth warning (AC-5.5, AC-5.6)
  const reasoningCount = allResolutions.filter(
    (r) => r.tier === REASONING_TIER
  ).length;
  const reasoningPercentage =
    totalCount > 0 ? reasoningCount / totalCount : 0;

  let researchDepthWarning = null;
  if (reasoningPercentage > REASONING_TIER_WARNING_THRESHOLD) {
    const pct = Math.round(reasoningPercentage * 100);
    researchDepthWarning = `${pct}% reasoning-tier (${reasoningCount}/${totalCount} self-resolutions)`;
  }

  return {
    // Preserve all existing base payload fields (AC-5.2)
    ...basePayload,
    // Sideband fields (AC-5.1)
    self_resolutions: retained,
    self_resolutions_truncated: truncatedCount,
    research_depth_warning: researchDepthWarning,
  };
}

// Alias for backward compatibility -- tests look for buildPayload or buildReturnPayload
export const buildPayload = buildReturnPayload;
