#!/usr/bin/env node

/**
 * Auto-Decision Engine
 *
 * Evaluates a batch of findings from convergence loop agents (investigator, challenger)
 * and determines whether each finding can be auto-accepted or must be escalated to a human.
 *
 * Three validation criteria for auto-accept (all must pass):
 *   1. Recommendation contains an explicit action verb
 *   2. Recommendation references a specific field or section
 *   3. Finding includes a structured confidence enum (high/medium)
 *
 * Escalation triggers:
 *   - Low confidence
 *   - Missing any validation criterion
 *   - No recommendation present
 *   - Critical severity without recommendation
 *   - Security-tagged finding (always escalates regardless of other criteria)
 *
 * Safety features:
 *   - Oscillation detection via findings_history
 *   - Circuit breaker (disable < 90% accuracy, re-enable > 95%)
 *   - All-or-nothing batch processing
 *   - Append-only audit trail with sequential entry IDs
 *   - Graceful degradation on failure
 *
 * Usage:
 *   node auto-decision.mjs evaluate --findings <json> --audit-path <path> [--findings-history <json>] [--circuit-breaker <json>]
 *   node auto-decision.mjs record-override --audit-path <path> --finding-id <id>
 *   node auto-decision.mjs circuit-breaker-status --audit-path <path>
 *
 * Implements: REQ-004, REQ-005, REQ-006, REQ-013, REQ-014, REQ-015, REQ-016,
 *   REQ-017, REQ-018, REQ-023, REQ-025, REQ-026
 * Spec: sg-autonomous-convergence
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';

// =============================================================================
// Constants
// =============================================================================

/** Valid confidence enum values (REQ-025). */
const VALID_CONFIDENCE_VALUES = ['high', 'medium', 'low'];

/** Confidence values eligible for auto-accept (REQ-013). */
const AUTO_ACCEPT_CONFIDENCE = ['high', 'medium'];

/** Common action verbs for criterion 1 validation. */
const ACTION_VERBS = [
  'add', 'remove', 'update', 'change', 'replace', 'rename', 'move',
  'delete', 'create', 'define', 'specify', 'document', 'implement',
  'fix', 'correct', 'modify', 'set', 'configure', 'enable', 'disable',
  'validate', 'verify', 'enforce', 'require', 'include', 'exclude',
  'extract', 'refactor', 'migrate', 'align', 'normalize', 'clarify',
];

/** Finding ID format: {agent_type}-{category}-{hash} (REQ-018). */
const FINDING_ID_PATTERN = /^[a-z]+-[a-z]+-[a-f0-9]+$/;

/** Circuit breaker thresholds (REQ-016). */
const CIRCUIT_BREAKER_DISABLE_THRESHOLD = 0.90;
const CIRCUIT_BREAKER_ENABLE_THRESHOLD = 0.95;
const CIRCUIT_BREAKER_WINDOW_SIZE = 10;

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate criterion 1: recommendation contains an explicit action verb.
 * @param {string|null} recommendation - The recommendation text
 * @returns {boolean}
 */
function hasActionVerb(recommendation) {
  if (!recommendation || typeof recommendation !== 'string') return false;
  const lower = recommendation.toLowerCase();
  return ACTION_VERBS.some(verb => {
    // Match verb at word boundary
    const pattern = new RegExp(`\\b${verb}\\b`, 'i');
    return pattern.test(lower);
  });
}

/**
 * Validate criterion 2: recommendation references a specific field or section.
 * Looks for field paths (dot notation), section headers, or backtick-quoted identifiers.
 * @param {string|null} recommendation - The recommendation text
 * @returns {boolean}
 */
function hasFieldReference(recommendation) {
  if (!recommendation || typeof recommendation !== 'string') return false;

  // Check for dot-notation field paths (e.g., "convergence.spec_complete")
  // Require at least one segment to be 3+ chars to avoid matching common
  // abbreviations like "e.g.", "i.e.", "a.m.", "p.m."
  const dotMatch = recommendation.match(/[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*/g);
  if (dotMatch) {
    const COMMON_ABBREVIATIONS = new Set(['e.g', 'i.e', 'a.m', 'p.m', 'vs', 'etc', 'al']);
    for (const m of dotMatch) {
      const lower = m.toLowerCase();
      // Skip known abbreviations
      if (COMMON_ABBREVIATIONS.has(lower)) continue;
      const parts = m.split('.');
      // Accept if at least one segment is 3+ chars (real field references)
      if (parts[0].length >= 3 || parts[1].length >= 3) return true;
    }
  }

  // Check for backtick-quoted identifiers (e.g., `review_state`)
  if (/`[a-zA-Z_][a-zA-Z0-9_]*`/.test(recommendation)) return true;

  // Check for section references (e.g., "Section X", "## X")
  if (/(?:section|field|column|property|attribute|parameter|key)\s+["`']?[a-zA-Z]/i.test(recommendation)) return true;

  // Check for file path references (require path separator to avoid matching "e.g.", "i.e.")
  if (/\/[a-zA-Z0-9_-]+\.[a-z]{2,4}/.test(recommendation)) return true;

  // Check for section heading references (e.g., "## Heading" or "section: foo")
  if (/##?\s+\w+/.test(recommendation) || /\bsection:\s*\w+/i.test(recommendation)) return true;

  // Check for underscore dot-notation field paths (e.g., "convergence.investigation_converged")
  // Require at least one underscore to distinguish from common abbreviations like "e.g." or "i.e."
  if (/\b[a-z_]*_[a-z_]*\.[a-z_]+\b/.test(recommendation) || /\b[a-z_]+\.[a-z_]*_[a-z_]*\b/.test(recommendation)) return true;

  return false;
}

/**
 * Validate criterion 3: structured confidence enum present and valid.
 * @param {string|null|undefined} confidence - The confidence enum value
 * @returns {boolean}
 */
function hasValidConfidence(confidence) {
  return typeof confidence === 'string' && VALID_CONFIDENCE_VALUES.includes(confidence);
}

/**
 * Validate finding ID format (REQ-018).
 * @param {string} findingId - The finding ID
 * @returns {boolean}
 */
function isValidFindingId(findingId) {
  return typeof findingId === 'string' && FINDING_ID_PATTERN.test(findingId);
}

/**
 * Generate a deterministic finding ID from components (REQ-018).
 * @param {string} agentType - Agent type (e.g., "inv", "chk")
 * @param {string} category - Finding category
 * @param {string} summary - Finding summary
 * @returns {string} Finding ID in format {agent_type}-{category}-{hash}
 */
export function generateFindingId(agentType, category, summary) {
  const hash = createHash('sha256')
    .update(summary)
    .digest('hex')
    .substring(0, 8);
  return `${agentType}-${category}-${hash}`;
}

// =============================================================================
// Oscillation Detection (REQ-015)
// =============================================================================

/**
 * Detect oscillation: a finding ID recurring after its fix was applied.
 * @param {string} findingId - Current finding ID
 * @param {Array} findingsHistory - Array of { finding_id, iteration, action }
 * @returns {boolean} True if oscillation detected
 */
function detectOscillation(findingId, findingsHistory) {
  if (!findingsHistory || !Array.isArray(findingsHistory)) return false;

  // Check if this finding was previously accepted (fix applied)
  return findingsHistory.some(
    entry => entry.finding_id === findingId && entry.action === 'accept'
  );
}

/**
 * Content-based oscillation detection fallback (REQ-018).
 * Uses similarity of finding summaries when IDs differ.
 * @param {string} summary - Current finding summary
 * @param {Array} findingsHistory - History entries with summaries
 * @returns {{ detected: boolean, matchedId: string|null }}
 */
function detectOscillationByContent(summary, findingsHistory) {
  if (!findingsHistory || !Array.isArray(findingsHistory) || !summary) {
    return { detected: false, matchedId: null };
  }

  for (const entry of findingsHistory) {
    if (entry.action !== 'accept' || !entry.summary) continue;

    // Simple similarity: check if normalized summaries share significant overlap
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const a = normalize(summary);
    const b = normalize(entry.summary);

    // If either is a substantial substring of the other, consider them the same issue
    if (a.length > 20 && b.length > 20) {
      if (a.includes(b) || b.includes(a)) {
        return { detected: true, matchedId: entry.finding_id };
      }

      // Word overlap ratio
      const wordsA = new Set(a.split(/\s+/));
      const wordsB = new Set(b.split(/\s+/));
      const intersection = [...wordsA].filter(w => wordsB.has(w));
      const ratio = intersection.length / Math.min(wordsA.size, wordsB.size);
      if (ratio > 0.8) {
        return { detected: true, matchedId: entry.finding_id };
      }
    }
  }

  return { detected: false, matchedId: null };
}

// =============================================================================
// Circuit Breaker (REQ-016)
// =============================================================================

/**
 * Evaluate circuit breaker state using a rolling window over audit trail entries.
 *
 * Both overrides and accepts are computed from the same window: the last
 * CIRCUIT_BREAKER_WINDOW_SIZE audit trail entries. Override events are
 * cross-referenced against entries in the window by finding_id.
 *
 * Accuracy = (window_total - window_overrides) / window_total
 *
 * @param {{ enabled: boolean, override_events: Array, total_auto_accepts: number, window_size: number, entries?: Array }} state
 * @returns {{ enabled: boolean, accuracy: number }}
 */
export function evaluateCircuitBreaker(state) {
  if (!state) return { enabled: true, accuracy: 1.0 };

  const windowSize = state.window_size || CIRCUIT_BREAKER_WINDOW_SIZE;
  const entries = state.entries || [];
  const overrideEvents = state.override_events || [];

  // Take the last windowSize entries as the rolling window
  const windowEntries = entries.slice(-windowSize);
  const windowTotal = windowEntries.length;

  if (windowTotal === 0) return { enabled: state.enabled, accuracy: 1.0 };

  // Build a set of overridden finding_ids for fast lookup
  const overriddenIds = new Set(overrideEvents.map(e => e.finding_id));

  // Count how many entries in the window were overridden
  const windowOverrides = windowEntries.filter(
    entry => overriddenIds.has(entry.finding_id)
  ).length;

  const accuracy = (windowTotal - windowOverrides) / windowTotal;

  if (state.enabled && accuracy < CIRCUIT_BREAKER_DISABLE_THRESHOLD) {
    return { enabled: false, accuracy };
  }

  if (!state.enabled && accuracy > CIRCUIT_BREAKER_ENABLE_THRESHOLD) {
    return { enabled: true, accuracy };
  }

  return { enabled: state.enabled, accuracy };
}

// =============================================================================
// Audit Trail (REQ-026)
// =============================================================================

/**
 * Load audit trail from file. Returns empty structure if file doesn't exist.
 * @param {string} auditPath - Path to audit trail file
 * @returns {{ entries: Array, override_events: Array, next_entry_id: number, circuit_breaker: { enabled: boolean, total_auto_accepts: number } }}
 */
function loadAuditTrail(auditPath) {
  if (!existsSync(auditPath)) {
    return {
      entries: [],
      override_events: [],
      next_entry_id: 1,
      circuit_breaker: {
        enabled: true,
        total_auto_accepts: 0,
      },
    };
  }

  try {
    const content = readFileSync(auditPath, 'utf8');
    const data = JSON.parse(content);
    return {
      entries: data.entries || [],
      override_events: data.override_events || [],
      next_entry_id: (data.entries?.length || 0) + 1,
      circuit_breaker: data.circuit_breaker || { enabled: true, total_auto_accepts: 0 },
    };
  } catch {
    // Corrupted file -- start fresh (graceful degradation)
    return {
      entries: [],
      override_events: [],
      next_entry_id: 1,
      circuit_breaker: { enabled: true, total_auto_accepts: 0 },
    };
  }
}

/**
 * Save audit trail atomically (write-to-temp-then-rename).
 * @param {string} auditPath - Path to audit trail file
 * @param {object} auditData - Audit trail data
 */
function saveAuditTrail(auditPath, auditData) {
  const tmpPath = auditPath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(auditData, null, 2) + '\n');
  renameSync(tmpPath, auditPath);
}

// =============================================================================
// Core Engine (REQ-004, REQ-005, REQ-006, REQ-013, REQ-014, REQ-017)
// =============================================================================

/**
 * Evaluate a single finding and return a decision.
 *
 * @param {object} finding - FindingOutput object
 * @param {Array} findingsHistory - Prior findings history for oscillation detection
 * @param {boolean} circuitBreakerEnabled - Whether auto-accept is enabled
 * @returns {{ action: 'accept'|'escalate', reason: string|null, validation_result: object, oscillation: boolean }}
 */
export function evaluateFinding(finding, findingsHistory = [], circuitBreakerEnabled = true) {
  const validationResult = {
    criterion_1_action_verb: false,
    criterion_2_field_reference: false,
    criterion_3_confidence_present: false,
  };

  // AC-2.9: Security-tagged findings always escalate
  if (finding.security_tagged === true) {
    return {
      action: 'escalate',
      reason: 'security-tagged finding (always escalates)',
      validation_result: validationResult,
      oscillation: false,
    };
  }

  // AC-2.8: Critical severity without recommendation always escalates
  if (finding.severity === 'critical' && !finding.recommendation) {
    return {
      action: 'escalate',
      reason: 'critical severity without recommendation',
      validation_result: validationResult,
      oscillation: false,
    };
  }

  // AC-2.7: No recommendation at all
  if (!finding.recommendation) {
    return {
      action: 'escalate',
      reason: 'no recommendation provided',
      validation_result: validationResult,
      oscillation: false,
    };
  }

  // Oscillation detection (AC-2.14)
  if (finding.finding_id) {
    const oscillation = detectOscillation(finding.finding_id, findingsHistory);
    if (oscillation) {
      return {
        action: 'escalate',
        reason: `oscillation detected: finding ${finding.finding_id} recurred after fix`,
        validation_result: validationResult,
        oscillation: true,
      };
    }
  }

  // Content-based oscillation fallback (AC-2.15)
  if (finding.summary) {
    const contentMatch = detectOscillationByContent(finding.summary, findingsHistory);
    if (contentMatch.detected) {
      return {
        action: 'escalate',
        reason: `oscillation detected via content match (matched ${contentMatch.matchedId})`,
        validation_result: validationResult,
        oscillation: true,
      };
    }
  }

  // Circuit breaker check
  if (!circuitBreakerEnabled) {
    return {
      action: 'escalate',
      reason: 'circuit breaker active (auto-accept disabled)',
      validation_result: validationResult,
      oscillation: false,
    };
  }

  // Validate three criteria (AC-2.1 through AC-2.6)
  validationResult.criterion_1_action_verb = hasActionVerb(finding.recommendation);
  validationResult.criterion_2_field_reference = hasFieldReference(finding.recommendation);
  validationResult.criterion_3_confidence_present = hasValidConfidence(finding.confidence);

  // AC-2.4: Missing action verb
  if (!validationResult.criterion_1_action_verb) {
    return {
      action: 'escalate',
      reason: 'recommendation missing action verb (criterion 1)',
      validation_result: validationResult,
      oscillation: false,
    };
  }

  // AC-2.5: Missing field reference
  if (!validationResult.criterion_2_field_reference) {
    return {
      action: 'escalate',
      reason: 'recommendation missing field/section reference (criterion 2)',
      validation_result: validationResult,
      oscillation: false,
    };
  }

  // AC-2.6: Missing confidence enum
  if (!validationResult.criterion_3_confidence_present) {
    return {
      action: 'escalate',
      reason: 'confidence enum missing or invalid (criterion 3)',
      validation_result: validationResult,
      oscillation: false,
    };
  }

  // AC-2.3: Low confidence always escalates
  if (finding.confidence === 'low') {
    return {
      action: 'escalate',
      reason: 'low confidence (escalation required)',
      validation_result: validationResult,
      oscillation: false,
    };
  }

  // AC-2.1, AC-2.2: All criteria pass with high/medium confidence
  return {
    action: 'accept',
    reason: null,
    validation_result: validationResult,
    oscillation: false,
  };
}

/**
 * Process a batch of findings with all-or-nothing semantics (AC-2.18).
 *
 * @param {Array} findings - Array of FindingOutput objects
 * @param {string} auditPath - Path to audit trail file
 * @param {Array} findingsHistory - Prior findings for oscillation detection
 * @returns {{ decisions: Array<{ finding_id: string, action: string, reason: string|null }>, escalations: Array, oscillations: Array }}
 */
export function processBatch(findings, auditPath, findingsHistory = []) {
  // Load audit trail for circuit breaker state and entry IDs
  const audit = loadAuditTrail(auditPath);
  const cbState = evaluateCircuitBreaker({
    enabled: audit.circuit_breaker.enabled,
    override_events: audit.override_events,
    total_auto_accepts: audit.circuit_breaker.total_auto_accepts,
    entries: audit.entries,
    window_size: CIRCUIT_BREAKER_WINDOW_SIZE,
  });

  const decisions = [];
  const escalations = [];
  const oscillations = [];
  const newEntries = [];
  let entryId = audit.next_entry_id;
  let newAutoAccepts = 0;

  for (const finding of findings) {
    const result = evaluateFinding(finding, findingsHistory, cbState.enabled);

    const entry = {
      entry_id: entryId++,
      finding_id: finding.finding_id || 'unknown',
      recommendation: finding.recommendation || null,
      action: result.action,
      confidence: finding.confidence || null,
      escalation_reason: result.reason,
      timestamp: new Date().toISOString(),
      validation_result: result.validation_result,
    };

    newEntries.push(entry);

    const decision = {
      finding_id: finding.finding_id || 'unknown',
      action: result.action,
      reason: result.reason,
    };

    decisions.push(decision);

    if (result.action === 'escalate') {
      escalations.push({
        ...decision,
        finding,
        oscillation: result.oscillation,
      });
    }

    if (result.oscillation) {
      oscillations.push({
        finding_id: finding.finding_id,
        summary: finding.summary,
      });
    }

    if (result.action === 'accept') {
      newAutoAccepts++;
    }
  }

  // All-or-nothing: commit all entries atomically (AC-2.18)
  try {
    audit.entries.push(...newEntries);
    audit.circuit_breaker.total_auto_accepts += newAutoAccepts;

    // Re-evaluate circuit breaker after this batch
    const updatedCb = evaluateCircuitBreaker({
      enabled: audit.circuit_breaker.enabled,
      override_events: audit.override_events,
      total_auto_accepts: audit.circuit_breaker.total_auto_accepts,
      entries: audit.entries,
      window_size: CIRCUIT_BREAKER_WINDOW_SIZE,
    });
    audit.circuit_breaker.enabled = updatedCb.enabled;

    saveAuditTrail(auditPath, audit);
  } catch (err) {
    // AC-2.18: Engine crash mid-batch = no decisions committed
    // The caller should present all findings to human (graceful degradation)
    throw new Error(`Auto-decision batch commit failed: ${err.message}. No decisions committed.`);
  }

  return { decisions, escalations, oscillations };
}

/**
 * Record a human override event for circuit breaker accuracy (AC-2.22).
 *
 * @param {string} auditPath - Path to audit trail file
 * @param {string} findingId - The finding ID that was overridden
 */
export function recordOverride(auditPath, findingId) {
  const audit = loadAuditTrail(auditPath);

  audit.override_events.push({
    finding_id: findingId,
    timestamp: new Date().toISOString(),
  });

  // Re-evaluate circuit breaker after recording override
  const cbState = evaluateCircuitBreaker({
    enabled: audit.circuit_breaker.enabled,
    override_events: audit.override_events,
    total_auto_accepts: audit.circuit_breaker.total_auto_accepts,
    entries: audit.entries,
    window_size: CIRCUIT_BREAKER_WINDOW_SIZE,
  });
  audit.circuit_breaker.enabled = cbState.enabled;

  saveAuditTrail(auditPath, audit);
}

// =============================================================================
// CLI Interface
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'evaluate': {
        const findingsIdx = args.indexOf('--findings');
        const auditIdx = args.indexOf('--audit-path');
        const historyIdx = args.indexOf('--findings-history');

        if (findingsIdx === -1 || auditIdx === -1) {
          console.error('Usage: auto-decision.mjs evaluate --findings <json> --audit-path <path> [--findings-history <json>]');
          process.exit(1);
        }

        const findings = JSON.parse(args[findingsIdx + 1]);
        const auditPath = args[auditIdx + 1];
        const findingsHistory = historyIdx !== -1 ? JSON.parse(args[historyIdx + 1]) : [];

        const result = processBatch(findings, auditPath, findingsHistory);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'record-override': {
        const auditIdx = args.indexOf('--audit-path');
        const findingIdx = args.indexOf('--finding-id');

        if (auditIdx === -1 || findingIdx === -1) {
          console.error('Usage: auto-decision.mjs record-override --audit-path <path> --finding-id <id>');
          process.exit(1);
        }

        recordOverride(args[auditIdx + 1], args[findingIdx + 1]);
        console.error('Override recorded successfully.');
        break;
      }

      case 'circuit-breaker-status': {
        const auditIdx = args.indexOf('--audit-path');
        if (auditIdx === -1) {
          console.error('Usage: auto-decision.mjs circuit-breaker-status --audit-path <path>');
          process.exit(1);
        }

        const audit = loadAuditTrail(args[auditIdx + 1]);
        const cbState = evaluateCircuitBreaker({
          enabled: audit.circuit_breaker.enabled,
          override_events: audit.override_events,
          total_auto_accepts: audit.circuit_breaker.total_auto_accepts,
          entries: audit.entries,
          window_size: CIRCUIT_BREAKER_WINDOW_SIZE,
        });

        console.log(JSON.stringify({
          enabled: cbState.enabled,
          accuracy: cbState.accuracy,
          total_auto_accepts: audit.circuit_breaker.total_auto_accepts,
          override_count: audit.override_events.length,
          entry_count: audit.entries.length,
        }, null, 2));
        break;
      }

      default:
        console.error('Usage: auto-decision.mjs <evaluate|record-override|circuit-breaker-status> [options]');
        process.exit(1);
    }
  } catch (err) {
    // AC-2.19: Graceful degradation on crash
    console.error(`Auto-decision engine error: ${err.message}`);
    process.exit(1);
  }
}

// Only run CLI when this file is the entry point (not when imported as a module)
const isEntryPoint = process.argv[1] && (
  process.argv[1].endsWith('auto-decision.mjs') ||
  process.argv[1].includes('auto-decision')
);
if (isEntryPoint) {
  main();
}
