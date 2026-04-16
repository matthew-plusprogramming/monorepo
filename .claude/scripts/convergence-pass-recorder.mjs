#!/usr/bin/env node

/**
 * SubagentStop hook: Convergence Pass Evidence Recorder
 *
 * Automatically records pass evidence when convergence check agents complete.
 * Extracts findings metadata from the agent's last_assistant_message text,
 * computes the canonical findings hash, and invokes session-checkpoint.mjs record-pass.
 *
 * Claude Code SubagentStop event envelope fields:
 *   - input.agent_type: string (agent name from .claude/agents/)
 *   - input.last_assistant_message: string (agent's final text response)
 *   - input.agent_transcript_path: string (JSONL transcript path)
 *   - input.agent_id: string (unique subagent instance ID)
 *   - input.agent_output: (NOT a real field -- legacy, used only if present for compat)
 *
 * Agent type allowlist (AC-3.3, REQ-021):
 *   interface-investigator -> investigation
 *   challenger             -> challenger
 *   code-reviewer          -> code_review
 *   security-reviewer      -> security_review
 *   unifier                -> unifier
 *   completion-verifier    -> completion_verifier
 *
 * Non-convergence agents are silently ignored (exit 0, empty JSON).
 *
 * On extraction failure (AC-3.5): records with null findings and manual_fallback source.
 * On any error: fail-open (exit 0, empty JSON).
 *
 * Implements: REQ-005 (AC-3.2), REQ-021 (AC-3.3), REQ-014 (AC-3.4, AC-3.5),
 *   REQ-024 (AC-3.6)
 * Spec: sg-convergence-audit-enforcement
 */

import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFindingsHash } from './lib/findings-hash.mjs';

// =============================================================================
// Constants
// =============================================================================

/**
 * Convergence agent type to gate name mapping (REQ-021).
 * Maps kebab-case agent names (from .claude/agents/) to underscore gate names.
 * Only agents in this map trigger pass evidence recording.
 */
const GATE_MAP = {
  'interface-investigator': 'investigation',
  'challenger': 'challenger',
  'code-reviewer': 'code_review',
  'security-reviewer': 'security_review',
  'unifier': 'unifier',
  'completion-verifier': 'completion_verifier',
};

/**
 * Gates that use High+ severity threshold (0 High/Critical = clean).
 * All other gates use Medium+ threshold (0 Medium/High/Critical = clean).
 */
const HIGH_PLUS_THRESHOLD_GATES = new Set(['code_review']);

// =============================================================================
// Stdin Reader
// =============================================================================

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  try {
    const raw = await readStdin();

    if (!raw || !raw.trim()) {
      console.log('{}');
      process.exit(0);
    }

    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      // Malformed JSON -- fail-open
      console.log('{}');
      process.exit(0);
    }

    // AC-3.3: Check agent type against allowlist
    const agentType = input.agent_type;

    // Defensive check: if agent_type is undefined/empty, warn and exit 0 (fail-open)
    if (!agentType || typeof agentType !== 'string' || agentType.trim() === '') {
      if (agentType !== undefined) {
        process.stderr.write(
          `[convergence-pass-recorder] WARNING: agent_type is empty or invalid -- ignoring event\n`
        );
      }
      console.log('{}');
      process.exit(0);
    }

    const gateName = GATE_MAP[agentType];

    if (!gateName) {
      // Non-convergence agent -- silently ignore
      console.log('{}');
      process.exit(0);
    }

    // Derive status from last_assistant_message text since input.status
    // is not a documented SubagentStop envelope field.
    // Backwards compat: if input.status exists (future Claude Code version), use it.
    const status = input.status;
    const isSuccessful = status === undefined || status === 'success';

    if (!isSuccessful) {
      process.stderr.write(
        `[convergence-pass-recorder] WARNING: Skipping pass recording for ${agentType} -- subagent status is "${status}" (expected "success" or absent)\n`
      );
      console.log('{}');
      process.exit(0);
    }

    // Get the agent's response text.
    // Prefer input.agent_output if present (backwards compat / future Claude Code versions),
    // otherwise use input.last_assistant_message (documented SubagentStop field).
    let responseText = '';
    let agentOutputData = null;

    if (input.agent_output) {
      // Legacy / future compat: agent_output may be a JSON string or object
      try {
        agentOutputData = typeof input.agent_output === 'string'
          ? JSON.parse(input.agent_output)
          : input.agent_output;
      } catch {
        // agent_output is not valid JSON -- treat as plain text
        if (typeof input.agent_output === 'string') {
          responseText = input.agent_output;
        }
      }
    }

    if (!agentOutputData && !responseText) {
      // Use last_assistant_message (the correct documented field)
      if (input.last_assistant_message && typeof input.last_assistant_message === 'string') {
        responseText = input.last_assistant_message;
      }
    }

    // If neither source provided response data, warn and exit (fail-open)
    if (!agentOutputData && !responseText) {
      process.stderr.write(
        `[convergence-pass-recorder] WARNING: No last_assistant_message or agent_output for ${agentType} -- recording as manual_fallback\n`
      );
      // Record with null findings as manual_fallback
      invokeRecordPass(gateName, null, null, false, agentType, 'manual_fallback', input);
      console.log('{}');
      process.exit(0);
    }

    // AC-3.4: Extract findings metadata
    let findingsCount = null;
    let findingsHash = null;
    let findingsIds = null;
    let clean = false;
    let source = 'hook';

    try {
      if (agentOutputData) {
        // Structured data available (from agent_output) -- use existing structured extraction
        const extractionSource = { ...input, ...agentOutputData, result: agentOutputData.result || input.result };
        findingsCount = extractFindingsCountFromStructured(extractionSource);
        findingsIds = extractFindingsIdsFromStructured(extractionSource);
        clean = extractCleanFromStructured(extractionSource, gateName);
      } else {
        // Text-based extraction from last_assistant_message
        const textResult = extractFindingsFromText(responseText, gateName);
        findingsCount = textResult.findingsCount;
        findingsIds = textResult.findingsIds;
        clean = textResult.clean;
      }

      // AC-3.5: If extraction returned null for both count and IDs,
      // treat as extraction failure and fall back to manual_fallback
      if (findingsCount === null && findingsIds === null) {
        findingsCount = null;
        findingsHash = null;
        clean = false;
        source = 'manual_fallback';
        process.stderr.write(
          `[convergence-pass-recorder] WARNING: Could not extract findings metadata for ${agentType} -- recording as manual_fallback\n`
        );
      } else {
        // Compute canonical hash if we have finding IDs
        if (findingsIds && Array.isArray(findingsIds) && findingsIds.length > 0) {
          findingsHash = computeFindingsHash(findingsIds);
        } else if (findingsCount === 0) {
          // Zero findings -- hash of empty array
          findingsHash = computeFindingsHash([]);
        }
      }
    } catch {
      // AC-3.5: Extraction failure -- fall back to manual_fallback
      findingsCount = null;
      findingsHash = null;
      clean = false;
      source = 'manual_fallback';
      process.stderr.write(
        `[convergence-pass-recorder] WARNING: Could not extract findings metadata for ${agentType} -- recording as manual_fallback\n`
      );
    }

    // Invoke record-pass
    invokeRecordPass(gateName, findingsCount, findingsHash, clean, agentType, source, input);

    // Output empty JSON (this hook does not provide additionalContext)
    console.log('{}');
  } catch (err) {
    // Top-level fail-open
    process.stderr.write(
      `[convergence-pass-recorder] Error: ${err.message}\n`
    );
    console.log('{}');
  }

  process.exit(0);
}

// =============================================================================
// Record-Pass Invocation
// =============================================================================

/**
 * Invoke session-checkpoint.mjs record-pass with extracted metadata.
 * Fail-open: catches errors and writes to stderr.
 */
function invokeRecordPass(gateName, findingsCount, findingsHash, clean, agentType, source, input) {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'session-checkpoint.mjs');
  const recordArgs = [
    scriptPath,
    'record-pass',
    gateName,
    '--findings-count', findingsCount !== null ? String(findingsCount) : 'null',
    '--findings-hash', findingsHash !== null ? findingsHash : 'null',
    '--clean', String(clean),
    '--agent-type', agentType,
    '--source', source,
  ];

  // Include auto-decision batch ID if present
  const batchId = input.auto_decision_batch_id;
  if (batchId) {
    recordArgs.push('--auto-decision-batch-id', String(batchId));
    const batchComplete = input.auto_decision_complete;
    if (batchComplete !== undefined) {
      recordArgs.push('--auto-decision-complete', String(batchComplete));
    }
  }

  try {
    execFileSync('node', recordArgs, {
      cwd: process.cwd(),
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    process.stderr.write(
      `[convergence-pass-recorder] WARNING: record-pass invocation failed: ${err.message}\n`
    );
  }
}

// =============================================================================
// Text-Based Extraction (from last_assistant_message)
// =============================================================================

/**
 * Regex patterns for extracting severity/count data from agent text responses.
 * Gate agents return findings in various text formats:
 *   - "Findings by severity: Critical 0 / High 0 / Medium 2 / Low 4"
 *   - "**Findings**: 0 Critical, 0 High, 0 Medium, 0 Low"
 *   - Markdown table: "| Critical | 0 |"
 *   - JSON block fenced with ```json or ```json:findings-summary
 */

/**
 * Extract findings metadata from agent response text.
 * Tries JSON block first, then regex-based text parsing.
 *
 * @param {string} text - The agent's last_assistant_message text
 * @param {string} gateName - The gate name (used for threshold selection)
 * @returns {{ findingsCount: number|null, findingsIds: string[]|null, clean: boolean }}
 */
function extractFindingsFromText(text, gateName) {
  if (!text || typeof text !== 'string') {
    return { findingsCount: null, findingsIds: null, clean: false };
  }

  // Step 1: Try JSON block extraction first
  const jsonResult = tryExtractJsonBlock(text);
  if (jsonResult !== null) {
    const count = jsonResult.findings_count ?? jsonResult.findingsCount ?? null;
    const ids = jsonResult.findings_ids ?? jsonResult.findingsIds ?? null;
    let clean = jsonResult.clean ?? null;
    if (clean === null && count !== null) {
      clean = count === 0;
    }
    return {
      findingsCount: count !== null ? Number(count) : null,
      findingsIds: Array.isArray(ids) ? ids : null,
      clean: clean === true || clean === 'true',
    };
  }

  // Step 2: Regex-based text parsing for severity/count patterns
  const severityCounts = parseSeverityCounts(text);
  if (severityCounts !== null) {
    const totalCount = (severityCounts.critical || 0)
      + (severityCounts.high || 0)
      + (severityCounts.medium || 0)
      + (severityCounts.low || 0);

    // Determine clean status based on gate threshold
    const useHighThreshold = HIGH_PLUS_THRESHOLD_GATES.has(gateName);
    let clean;
    if (useHighThreshold) {
      // High+ threshold: clean if 0 Critical and 0 High
      clean = (severityCounts.critical || 0) === 0 && (severityCounts.high || 0) === 0;
    } else {
      // Medium+ threshold (default): clean if 0 Critical, 0 High, 0 Medium
      clean = (severityCounts.critical || 0) === 0
        && (severityCounts.high || 0) === 0
        && (severityCounts.medium || 0) === 0;
    }

    return { findingsCount: totalCount, findingsIds: null, clean };
  }

  // No findings data found in text
  return { findingsCount: null, findingsIds: null, clean: false };
}

/**
 * Try to extract a JSON block from the text.
 * Looks for ```json or ```json:findings-summary fenced blocks.
 *
 * @param {string} text
 * @returns {object|null} Parsed JSON object or null
 */
function tryExtractJsonBlock(text) {
  // Match ```json:findings-summary ... ``` or ```json ... ```
  const jsonBlockPattern = /```json(?::findings-summary)?\s*\n([\s\S]*?)```/;
  const match = text.match(jsonBlockPattern);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    // Validate it looks like findings data (has at least one expected field)
    if (parsed && typeof parsed === 'object' &&
        ('findings_count' in parsed || 'findingsCount' in parsed ||
         'findings_ids' in parsed || 'findingsIds' in parsed ||
         'clean' in parsed || 'critical' in parsed)) {
      return parsed;
    }
  } catch {
    // Not valid JSON -- fall through
  }
  return null;
}

/**
 * Parse severity/count patterns from text.
 * Handles multiple common formats:
 *   - "Findings by severity: Critical 0 / High 0 / Medium 2 / Low 4"
 *   - "**Findings**: 0 Critical, 0 High, 0 Medium, 0 Low"
 *   - "| Severity | Count |\n| Critical | 0 |"
 *   - "Critical: 0, High: 0, Medium: 2, Low: 4"
 *   - "Critical 0 / High 0 / Medium 2 / Low 4"
 *
 * @param {string} text
 * @returns {{ critical: number, high: number, medium: number, low: number }|null}
 */
function parseSeverityCounts(text) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let matched = false;

  // Pattern 1: "Critical N" or "N Critical" (with optional separators: /, |, comma)
  // Case-insensitive to handle variations
  const severities = ['critical', 'high', 'medium', 'low'];

  for (const severity of severities) {
    // "Severity N" pattern (e.g., "Critical 0", "Critical: 0")
    const severityFirstPattern = new RegExp(`${severity}[:\\s]+?(\\d+)`, 'i');
    const m1 = text.match(severityFirstPattern);
    if (m1) {
      counts[severity] = parseInt(m1[1], 10);
      matched = true;
      continue;
    }

    // "N Severity" pattern (e.g., "0 Critical")
    const countFirstPattern = new RegExp(`(\\d+)\\s+${severity}`, 'i');
    const m2 = text.match(countFirstPattern);
    if (m2) {
      counts[severity] = parseInt(m2[1], 10);
      matched = true;
      continue;
    }

    // Markdown table pattern: "| Critical | 0 |" or "| critical | 0 |"
    const tablePattern = new RegExp(`\\|\\s*${severity}\\s*\\|\\s*(\\d+)\\s*\\|`, 'i');
    const m3 = text.match(tablePattern);
    if (m3) {
      counts[severity] = parseInt(m3[1], 10);
      matched = true;
    }
  }

  return matched ? counts : null;
}

// =============================================================================
// Structured Data Extraction (from agent_output -- backwards compat)
// =============================================================================

/**
 * Extract findings_count from structured agent return payload.
 * Checks multiple possible locations in the return data.
 */
function extractFindingsCountFromStructured(input) {
  // Direct field
  if (input.findings_count !== undefined && input.findings_count !== null) {
    return Number(input.findings_count);
  }
  // Nested in result
  if (input.result?.findings_count !== undefined) {
    return Number(input.result.findings_count);
  }
  // From findings array length
  const ids = extractFindingsIdsFromStructured(input);
  if (ids && Array.isArray(ids)) {
    return ids.length;
  }
  return null;
}

/**
 * Extract findings_ids array from structured agent return payload.
 */
function extractFindingsIdsFromStructured(input) {
  if (Array.isArray(input.findings_ids)) {
    return input.findings_ids;
  }
  if (Array.isArray(input.result?.findings_ids)) {
    return input.result.findings_ids;
  }
  // Try to extract from findings array objects
  if (Array.isArray(input.findings)) {
    return input.findings.map(f => f.id || f.finding_id).filter(Boolean);
  }
  if (Array.isArray(input.result?.findings)) {
    return input.result.findings.map(f => f.id || f.finding_id).filter(Boolean);
  }
  return null;
}

/**
 * Extract clean status from structured agent return payload.
 * A pass is clean if findings_count is 0 or explicitly marked clean.
 */
function extractCleanFromStructured(input, _gateName) {
  // Explicit clean field
  if (input.clean !== undefined) {
    return input.clean === true || input.clean === 'true';
  }
  if (input.result?.clean !== undefined) {
    return input.result.clean === true || input.result.clean === 'true';
  }
  // Derive from findings count
  const count = extractFindingsCountFromStructured(input);
  if (count !== null) {
    return count === 0;
  }
  // Default to not clean (conservative)
  return false;
}

main();
