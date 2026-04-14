#!/usr/bin/env node

/**
 * SubagentStop hook: Convergence Pass Evidence Recorder
 *
 * Automatically records pass evidence when convergence check agents complete.
 * Extracts findings metadata from the agent's return payload, computes the
 * canonical findings hash, and invokes session-checkpoint.mjs record-pass.
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
    const agentType = input.agent_type || '';
    const gateName = GATE_MAP[agentType];

    if (!gateName) {
      // Non-convergence agent -- silently ignore
      console.log('{}');
      process.exit(0);
    }

    // Status validation: Only record a pass if the subagent completed successfully.
    // Matches the pattern in convergence-gate-reminder.mjs (AC-1.2, AC-1.3):
    // absent/undefined status is treated as success (backwards compatibility),
    // but "partial" or "failed" statuses must not record a pass.
    const status = input.status;
    const isSuccessful = status === undefined || status === 'success';

    if (!isSuccessful) {
      process.stderr.write(
        `[convergence-pass-recorder] WARNING: Skipping pass recording for ${agentType} -- subagent status is "${status}" (expected "success" or absent)\n`
      );
      console.log('{}');
      process.exit(0);
    }

    // AC-3.6: Parse agent_output (JSON string) to access the original agent return data
    let agentOutputData = null;
    if (input.agent_output) {
      try {
        agentOutputData = typeof input.agent_output === 'string'
          ? JSON.parse(input.agent_output)
          : input.agent_output;
      } catch {
        // agent_output is not valid JSON -- will fall through to manual_fallback
      }
    }

    // Merge agent_output fields into a combined extraction source
    // so extraction helpers can find findings data regardless of nesting
    const extractionSource = agentOutputData
      ? { ...input, ...agentOutputData, result: agentOutputData.result || input.result }
      : input;

    // AC-3.4: Extract findings metadata from return payload
    let findingsCount = null;
    let findingsHash = null;
    let findingsIds = null;
    let clean = false;
    let source = 'hook';

    try {
      // The agent return payload may include findings metadata in various locations
      findingsCount = extractFindingsCount(extractionSource);
      findingsIds = extractFindingsIds(extractionSource);
      clean = extractClean(extractionSource);

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

    // Build record-pass arguments
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

    // Invoke record-pass (fail-open: catch errors)
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
// Extraction Helpers
// =============================================================================

/**
 * Extract findings_count from agent return payload.
 * Checks multiple possible locations in the return data.
 */
function extractFindingsCount(input) {
  // Direct field
  if (input.findings_count !== undefined && input.findings_count !== null) {
    return Number(input.findings_count);
  }
  // Nested in result
  if (input.result?.findings_count !== undefined) {
    return Number(input.result.findings_count);
  }
  // From findings array length
  const ids = extractFindingsIds(input);
  if (ids && Array.isArray(ids)) {
    return ids.length;
  }
  return null;
}

/**
 * Extract findings_ids array from agent return payload.
 */
function extractFindingsIds(input) {
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
 * Extract clean status from agent return payload.
 * A pass is clean if findings_count is 0 or explicitly marked clean.
 */
function extractClean(input) {
  // Explicit clean field
  if (input.clean !== undefined) {
    return input.clean === true || input.clean === 'true';
  }
  if (input.result?.clean !== undefined) {
    return input.result.clean === true || input.result.clean === 'true';
  }
  // Derive from findings count
  const count = extractFindingsCount(input);
  if (count !== null) {
    return count === 0;
  }
  // Default to not clean (conservative)
  return false;
}

main();
