#!/usr/bin/env node

/**
 * PreToolUse Gate Enforcement Hook (Agent matcher)
 *
 * Blocks dispatch of enforced subagent types when their workflow prerequisites
 * have not been satisfied. Reads session.json dispatch history and convergence
 * state as the source of truth -- no cooperative participation required.
 *
 * Implementer prerequisites are convergence-type: investigation and challenger
 * gates must have clean_pass_count >= 2 in session.json (AC-1.7, AC-1.8).
 *
 * Invocation: Receives stdin JSON from Claude Code PreToolUse hook system.
 * Input format: { session_id: string, tool_name: string, tool_input: { subagent_type: string, ... } }
 *
 * Exit codes:
 *   0 - Allow dispatch (prerequisites met, exempt workflow, fail-open, etc.)
 *   2 - Block dispatch (prerequisites not met, stderr message describes what's missing)
 *
 * Fail-open: Any structural error (missing session.json, malformed JSON, script crash)
 *   results in exit 0. Exception: missing convergence fields default to 0 (fail-closed).
 *
 * Implements: REQ-003, REQ-004, REQ-005, REQ-006, REQ-011, REQ-013, REQ-014,
 *   REQ-015, REQ-020, REQ-021, REQ-022, REQ-023, REQ-024, REQ-025, REQ-026,
 *   REQ-027, REQ-028, REQ-029, REQ-031, REQ-032, REQ-034
 * Spec: sg-coercive-gate-enforcement
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENFORCED_SUBAGENT_TYPES,
  OVERRIDE_GATE_NAMES,
  getWorkflowTypeStrict,
  isExemptWorkflow,
  getPrerequisites,
  werePrerequisitesMet,
} from './lib/workflow-dag.mjs';
import {
  readStdin,
  findClaudeDir,
  loadSession,
  loadOverrides,
  findMatchingOverride,
} from './lib/hook-utils.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Sentinel file that disables enforcement (kill switch). */
const KILL_SWITCH_FILENAME = 'gate-enforcement-disabled';

/** Override file for human-provided gate overrides. */
const OVERRIDE_FILENAME = 'gate-override.json';

/**
 * Output a blocking message to stderr and exit with code 2.
 * Includes the blocked subagent type, missing prerequisites, guidance,
 * and the current session_id (AC-2.18).
 *
 * @param {string} subagentType - The blocked subagent type
 * @param {Array} missing - Array of { prerequisite, gate_name } objects
 * @param {string} sessionId - Current session ID from stdin
 */
function blockDispatch(subagentType, missing, sessionId) {
  process.stderr.write('\n');
  process.stderr.write('========================================\n');
  process.stderr.write('BLOCKED: Workflow Gate Enforcement\n');
  process.stderr.write('========================================\n');
  process.stderr.write('\n');
  process.stderr.write(`Cannot dispatch '${subagentType}' -- prerequisites not met.\n`);
  process.stderr.write('\n');
  process.stderr.write('Missing prerequisites:\n');

  for (const m of missing) {
    const prereq = m.prerequisite;
    if (prereq.type === 'dispatch') {
      if (prereq.subagent_type === 'challenger') {
        const stage = prereq.stage || 'unknown';
        process.stderr.write(`  - Run /challenge (stage: ${stage}) to dispatch the required 'challenger' first\n`);
      } else if (prereq.subagent_type === 'unifier') {
        process.stderr.write(`  - Run /unify on the spec group to dispatch the required 'unifier' first\n`);
      } else if (prereq.subagent_type === 'documenter') {
        process.stderr.write(`  - Run /docs on the spec group to dispatch the required 'documenter' first\n`);
      } else {
        process.stderr.write(`  - Dispatch '${prereq.subagent_type}' first (use the corresponding skill command)\n`);
      }
    } else if (prereq.type === 'convergence') {
      const skillMap = {
        investigation: '/investigate',
        challenger: '/challenge',
        code_review: '/code-review',
        security_review: '/security',
      };
      const skill = skillMap[prereq.gate] || prereq.gate;
      process.stderr.write(
        `  - Run the convergence loop for '${prereq.gate}' until ${prereq.required_count} consecutive clean passes are recorded.\n` +
        `    Use: ${skill} (repeat until clean), then record with: node .claude/scripts/session-checkpoint.mjs update-convergence ${prereq.gate} ${prereq.required_count}\n`
      );
    }
  }

  process.stderr.write('\n');
  process.stderr.write('How to unblock:\n');
  process.stderr.write('  1. Complete the missing prerequisite dispatches or convergence loops listed above\n');
  process.stderr.write('  2. Then retry this dispatch\n');
  process.stderr.write('\n');
  process.stderr.write('========================================\n');
  process.stderr.write('\n');

  process.exit(2);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  try {
    // Step 1: Read and parse stdin
    const stdinContent = await readStdin();

    if (!stdinContent.trim()) {
      process.exit(0); // No input -- fail-open
    }

    let inputData;
    try {
      inputData = JSON.parse(stdinContent);
    } catch {
      process.exit(0); // Malformed input -- fail-open
    }

    // Extract session_id and subagent_type from stdin JSON
    const sessionId = inputData.session_id || 'unknown';
    const toolInput = inputData.tool_input || {};
    const subagentType = toolInput.subagent_type;

    // Resolve .claude directory
    const claudeDir = findClaudeDir(import.meta.url);
    const coordinationDir = join(claudeDir, 'coordination');

    // Step 2: Check kill switch FIRST (REQ-021, AC-2.14)
    const killSwitchPath = join(coordinationDir, KILL_SWITCH_FILENAME);
    if (existsSync(killSwitchPath)) {
      // Security fix M3: audit trail for kill switch bypass
      process.stderr.write('[workflow-enforcement] WARNING: gate-enforcement-disabled is active -- enforcement bypassed\n');
      process.exit(0); // Kill switch active -- all enforcement disabled
    }

    // Step 3: Read session.json
    const sessionPath = join(claudeDir, 'context', 'session.json');
    const session = loadSession(sessionPath);

    if (!session) {
      process.exit(0); // AC-2.9: Missing session.json -- fail-open
    }

    // Step 4: Check active_work exists
    if (!session.active_work) {
      process.exit(0); // AC-2.10: Missing active_work -- fail-open
    }

    // Step 5: Get workflow type (strict -- null means fail-open)
    const workflow = getWorkflowTypeStrict(session);
    if (!workflow) {
      process.exit(0); // No workflow set -- fail-open
    }

    // Step 6: Check exempt workflow (AC-2.8)
    if (isExemptWorkflow(workflow)) {
      process.exit(0); // Exempt workflow -- no enforcement
    }

    // Step 7: Check subagent_type is enforced (AC-2.7)
    if (!subagentType || typeof subagentType !== 'string') {
      process.exit(0); // No subagent_type -- fail-open (passthrough)
    }

    if (!ENFORCED_SUBAGENT_TYPES.includes(subagentType)) {
      process.exit(0); // Non-enforced subagent type -- passthrough (REQ-006)
    }

    // Step 8: Get prerequisites for this subagent type + workflow
    const prerequisites = getPrerequisites(workflow, subagentType);

    if (prerequisites.length === 0) {
      process.exit(0); // No prerequisites defined -- allow
    }

    // Step 9: Check if prerequisites are met
    const result = werePrerequisitesMet(session, prerequisites);

    if (result.met) {
      process.exit(0); // All prerequisites met -- allow dispatch
    }

    // Step 10: Prerequisites not met -- check for override
    const overridePath = join(coordinationDir, OVERRIDE_FILENAME);
    const overrides = loadOverrides(overridePath);

    if (overrides) {
      // Check each missing prerequisite for an override
      const stillMissing = result.missing.filter(m => {
        const override = findMatchingOverride(overrides, m.gate_name, sessionId);
        return !override; // Keep only those without a valid override
      });

      if (stillMissing.length === 0) {
        process.exit(0); // All missing prerequisites overridden -- allow dispatch
      }

      // Block with only the still-missing prerequisites
      blockDispatch(subagentType, stillMissing, sessionId);
    } else {
      // No overrides file -- block with all missing prerequisites
      blockDispatch(subagentType, result.missing, sessionId);
    }
  } catch (err) {
    // AC-2.12: Top-level try/catch -- fail-open on any error
    process.stderr.write(`Error in workflow-gate-enforcement hook: ${err.message}\n`);
    process.exit(0);
  }
}

main();
