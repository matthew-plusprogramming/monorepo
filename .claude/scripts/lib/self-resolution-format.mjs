/**
 * Self-resolution format validation and construction utilities.
 *
 * Provides functions to parse, validate, and construct SELF-RESOLVED format
 * strings per the self-answer protocol. Used by agents (via audit writer)
 * and by validation tooling.
 *
 * Spec: sg-self-answering-agents (Task 8)
 * ACs: AC-4.1, AC-4.2, AC-4.3, AC-4.4
 */

// =============================================================================
// Constants
// =============================================================================

/** Valid tier names (string form used in inline format). */
export const TIER_NAMES = ['code', 'spec', 'memory', 'reasoning'];

/** Mapping from tier name to integer. */
export const TIER_NAME_TO_INT = {
  code: 1,
  spec: 2,
  memory: 3,
  reasoning: 4,
};

/** Mapping from tier integer to name. */
export const TIER_INT_TO_NAME = {
  1: 'code',
  2: 'spec',
  3: 'memory',
  4: 'reasoning',
};

/** Tiers that require evidence snippets (1=code, 2=spec). */
export const SNIPPET_REQUIRED_TIERS = [1, 2];

/** Maximum length for an evidence snippet (one line). */
export const MAX_SNIPPET_LENGTH_CHARS = 200;

/**
 * Regex for parsing the full SELF-RESOLVED inline format.
 *
 * Captures:
 *   1: tier name (code|spec|memory|reasoning)
 *   2: description
 *   3: (optional) evidence portion after " -- "
 */
const SELF_RESOLVED_PATTERN =
  /^SELF-RESOLVED\((code|spec|memory|reasoning)\):\s+(.+?)(?:\s+--\s+(.+))?$/;

/**
 * Regex for parsing the evidence snippet portion.
 *
 * Captures:
 *   1: snippet text (inside quotes)
 *   2: file:line reference
 */
const EVIDENCE_PATTERN = /^evidence:\s+"(.+?)"\s+@\s+(.+:\d+)$/;

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate a tier value (integer 1-4).
 *
 * @param {number} tier - Tier integer to validate
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateTier(tier) {
  if (typeof tier !== 'number' || !Number.isInteger(tier)) {
    return {
      valid: false,
      error: `Tier must be an integer, got ${typeof tier}`,
    };
  }
  if (tier < 1 || tier > 4) {
    return { valid: false, error: `Tier must be 1-4, got ${tier}` };
  }
  return { valid: true, error: null };
}

/**
 * Validate a self-resolution entry's required fields.
 *
 * Checks that:
 * - tier is valid (1-4)
 * - question and resolution are non-empty strings
 * - tier 1-2 entries have evidence_snippet and source_ref
 * - tier 3-4 entries allow null evidence_snippet and source_ref
 * - evidence_snippet does not exceed MAX_SNIPPET_LENGTH_CHARS
 *
 * @param {object} entry - Self-resolution entry to validate
 * @param {number} entry.tier - Tier integer (1-4)
 * @param {string} entry.question - The question that was resolved
 * @param {string} entry.resolution - The resolution answer
 * @param {string|null} entry.evidence_snippet - Evidence snippet (required for tier 1-2)
 * @param {string|null} entry.source_ref - Source reference file:line (required for tier 1-2)
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateResolutionEntry(entry) {
  const errors = [];

  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be a non-null object'] };
  }

  // Validate tier
  const tierResult = validateTier(entry.tier);
  if (!tierResult.valid) {
    errors.push(tierResult.error);
  }

  // Validate question
  if (
    typeof entry.question !== 'string' ||
    entry.question.trim().length === 0
  ) {
    errors.push('question must be a non-empty string');
  }

  // Validate resolution
  if (
    typeof entry.resolution !== 'string' ||
    entry.resolution.trim().length === 0
  ) {
    errors.push('resolution must be a non-empty string');
  }

  // Validate evidence for tier 1-2
  if (entry.tier >= 1 && entry.tier <= 2) {
    if (
      typeof entry.evidence_snippet !== 'string' ||
      entry.evidence_snippet.trim().length === 0
    ) {
      errors.push(
        `evidence_snippet is required for tier ${entry.tier} (${TIER_INT_TO_NAME[entry.tier]})`
      );
    } else if (entry.evidence_snippet.length > MAX_SNIPPET_LENGTH_CHARS) {
      errors.push(
        `evidence_snippet exceeds max length (${entry.evidence_snippet.length} > ${MAX_SNIPPET_LENGTH_CHARS})`
      );
    }

    if (
      typeof entry.source_ref !== 'string' ||
      entry.source_ref.trim().length === 0
    ) {
      errors.push(
        `source_ref is required for tier ${entry.tier} (${TIER_INT_TO_NAME[entry.tier]})`
      );
    }
  }

  // Tier 3-4: evidence_snippet and source_ref may be null
  if (entry.tier >= 3 && entry.tier <= 4) {
    if (
      entry.evidence_snippet !== null &&
      entry.evidence_snippet !== undefined
    ) {
      if (typeof entry.evidence_snippet !== 'string') {
        errors.push('evidence_snippet must be a string or null for tier 3-4');
      }
    }
    if (entry.source_ref !== null && entry.source_ref !== undefined) {
      if (typeof entry.source_ref !== 'string') {
        errors.push('source_ref must be a string or null for tier 3-4');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// =============================================================================
// Format Construction
// =============================================================================

/**
 * Construct a SELF-RESOLVED inline format string.
 *
 * @param {object} params
 * @param {number} params.tier - Tier integer (1-4)
 * @param {string} params.description - Description of the resolution
 * @param {string|null} [params.evidence_snippet] - Evidence snippet (required for tier 1-2)
 * @param {string|null} [params.source_ref] - Source reference file:line (required for tier 1-2)
 * @returns {string} Formatted SELF-RESOLVED string
 * @throws {Error} If tier is invalid or required fields missing
 */
export function formatSelfResolved({
  tier,
  description,
  evidence_snippet,
  source_ref,
}) {
  const tierResult = validateTier(tier);
  if (!tierResult.valid) {
    throw new Error(tierResult.error);
  }

  const tierName = TIER_INT_TO_NAME[tier];

  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('description must be a non-empty string');
  }

  // Tier 1-2: include evidence snippet
  if (SNIPPET_REQUIRED_TIERS.includes(tier)) {
    if (!evidence_snippet || !source_ref) {
      throw new Error(
        `evidence_snippet and source_ref are required for tier ${tier} (${tierName})`
      );
    }
    return `SELF-RESOLVED(${tierName}): ${description} -- evidence: "${evidence_snippet}" @ ${source_ref}`;
  }

  // Tier 3-4: no snippet required
  return `SELF-RESOLVED(${tierName}): ${description}`;
}

// =============================================================================
// Format Parsing
// =============================================================================

/**
 * Parse a SELF-RESOLVED inline format string.
 *
 * @param {string} text - The inline format string to parse
 * @returns {{ valid: boolean, tier: string|null, tierInt: number|null, description: string|null, evidence_snippet: string|null, source_ref: string|null, error: string|null }}
 */
export function parseSelfResolved(text) {
  if (typeof text !== 'string') {
    return {
      valid: false,
      tier: null,
      tierInt: null,
      description: null,
      evidence_snippet: null,
      source_ref: null,
      error: 'Input must be a string',
    };
  }

  const match = text.match(SELF_RESOLVED_PATTERN);
  if (!match) {
    return {
      valid: false,
      tier: null,
      tierInt: null,
      description: null,
      evidence_snippet: null,
      source_ref: null,
      error: 'Does not match SELF-RESOLVED format',
    };
  }

  const tier = match[1];
  const tierInt = TIER_NAME_TO_INT[tier];
  const description = match[2];
  const evidencePart = match[3] || null;

  let evidence_snippet = null;
  let source_ref = null;

  if (evidencePart) {
    const evidenceMatch = evidencePart.match(EVIDENCE_PATTERN);
    if (evidenceMatch) {
      evidence_snippet = evidenceMatch[1];
      source_ref = evidenceMatch[2];
    }
  }

  return {
    valid: true,
    tier,
    tierInt,
    description,
    evidence_snippet,
    source_ref,
    error: null,
  };
}

// =============================================================================
// Escalation Boundary Decision Logic
// =============================================================================

/**
 * Decision outcomes for the escalation boundary evaluation.
 */
export const ESCALATION_DECISION = {
  SELF_RESOLVE: 'self_resolve',
  ESCALATE: 'escalate',
};

/**
 * Evaluate whether an agent should self-resolve or escalate a question.
 *
 * Implements the escalation boundary rules from the self-answer protocol:
 * 1. No answer found (empty tiers) -> escalate
 * 2. Observable behavior + reasoning-only -> escalate
 * 3. Cross-tier conflict -> escalate
 * 4. Out of domain -> escalate
 * 5. Otherwise -> self-resolve
 *
 * @param {object} params
 * @param {Array<{tier: number, answer: string, evidenceSnippet?: string, sourceRef?: string}>} params.tiers - Available tier evidence
 * @param {boolean} params.isObservableBehavior - Whether the question involves observable behavior
 * @param {boolean} params.isInDomain - Whether the question is within the agent's acceptable assumption domain
 * @param {string} [params.question] - The question being evaluated
 * @param {boolean} [params.hasConflict] - Whether cross-tier conflict exists
 * @param {Array<{tier: number, consulted: string, result: string}>} [params.researchTrail] - Research trail for no-answer escalation
 * @returns {{ decision: string }}
 */
export function evaluateResolution({
  tiers = [],
  isObservableBehavior = false,
  isInDomain = true,
  hasConflict = false,
}) {
  // Rule 1: No answer found -- escalate (AC-6.4)
  if (!tiers || tiers.length === 0) {
    return { decision: ESCALATION_DECISION.ESCALATE };
  }

  // Rule 2: Out of domain -- escalate (AC-6.3)
  if (!isInDomain) {
    return { decision: ESCALATION_DECISION.ESCALATE };
  }

  // Rule 3: Cross-tier conflict -- escalate (AC-6.2)
  if (hasConflict) {
    return { decision: ESCALATION_DECISION.ESCALATE };
  }

  // Rule 4: Observable behavior + reasoning-only -> escalate (AC-6.1)
  if (isObservableBehavior) {
    const hasHigherTierEvidence = tiers.some((t) => t.tier < 4);
    if (!hasHigherTierEvidence) {
      return { decision: ESCALATION_DECISION.ESCALATE };
    }
  }

  // Default: self-resolve
  return { decision: ESCALATION_DECISION.SELF_RESOLVE };
}
