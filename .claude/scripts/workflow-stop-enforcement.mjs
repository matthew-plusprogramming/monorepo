#!/usr/bin/env node

/**
 * Stop Hook: Workflow Completion Enforcement
 *
 * Blocks session completion when mandatory dispatches have not occurred
 * for spec-based workflows (oneoff-spec, orchestrator).
 *
 * Stop hooks use stdout JSON for blocking: {"decision": "block", "reason": "..."}
 * NOT stderr + exit 2 (that's for PreToolUse hooks).
 *
 * Mandatory dispatches checked (any status satisfies):
 *   1. code-reviewer
 *   2. security-reviewer
 *   3. completion-verifier
 *   4. documenter
 *
 * Invocation: Receives stdin JSON from Claude Code Stop hook system.
 *
 * Exit codes:
 *   0 - Allow session completion (all mandatory dispatches present, or exempt)
 *   (blocking is via stdout JSON, not exit code)
 *
 * Implements: REQ-008, REQ-009, REQ-010, REQ-025, REQ-030
 * Spec: sg-coercive-gate-enforcement
 */

import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  STOP_MANDATORY_DISPATCHES,
  STOP_PHASE_REQUIREMENTS,
  OVERRIDE_GATE_NAMES,
  getWorkflowTypeStrict,
  isExemptWorkflow,
  getAllTasks,
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

/** Sentinel file to prevent Stop hook infinite loops (AC-4.6). */
const STOP_HOOK_ACTIVE_FILENAME = 'stop-hook-active';

/** Override file for human-provided gate overrides. */
const OVERRIDE_FILENAME = 'gate-override.json';

/**
 * Safely delete a file if it exists.
 * @param {string} filePath - Path to file
 */
function safeDelete(filePath) {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Ignore errors on delete
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  try {
    // Read stdin (Stop hook event data)
    const stdinContent = await readStdin();

    let inputData = {};
    try {
      if (stdinContent.trim()) {
        inputData = JSON.parse(stdinContent);
      }
    } catch {
      // Malformed input -- continue with empty data
    }

    const sessionId = inputData.session_id || 'unknown';

    // Resolve .claude directory
    const claudeDir = findClaudeDir(import.meta.url);
    const coordinationDir = join(claudeDir, 'coordination');

    // Step 1: Check kill switch FIRST (REQ-021, AC-4.9)
    const killSwitchPath = join(coordinationDir, KILL_SWITCH_FILENAME);
    if (existsSync(killSwitchPath)) {
      // Security fix M3: audit trail for kill switch bypass
      process.stderr.write('[workflow-enforcement] WARNING: gate-enforcement-disabled is active -- enforcement bypassed\n');
      process.exit(0); // Kill switch active -- enforcement disabled
    }

    // Step 2: Read session.json
    const sessionPath = join(claudeDir, 'context', 'session.json');
    const session = loadSession(sessionPath);

    if (!session) {
      process.exit(0); // AC-4.8: Missing session.json -- fail-open
    }

    // Step 3: Check stop-hook-active sentinel (AC-4.6, REQ-009, REQ-030)
    const sentinelPath = join(coordinationDir, STOP_HOOK_ACTIVE_FILENAME);
    if (existsSync(sentinelPath)) {
      // Re-entry detected -- exit 0 to prevent infinite loop
      // Delete the sentinel so subsequent non-blocking runs can proceed
      safeDelete(sentinelPath);
      process.exit(0);
    }

    // Step 4: Check active_work exists
    if (!session.active_work) {
      process.exit(0); // No active work -- fail-open
    }

    // Step 5: Get workflow type
    const workflow = getWorkflowTypeStrict(session);
    if (!workflow) {
      process.exit(0); // No workflow set -- fail-open
    }

    // Step 6: Check exempt workflow (AC-4.7)
    if (isExemptWorkflow(workflow)) {
      process.exit(0); // Exempt workflow -- no enforcement
    }

    // Step 7: Phase-aware mandatory dispatch check (REQ-001 through REQ-008)
    // Determine which dispatches are required based on current session phase.
    // Phases not in STOP_PHASE_REQUIREMENTS require zero dispatches (exit 0).
    const currentPhase = session.active_work.current_phase;

    if (!currentPhase || typeof currentPhase !== 'string') {
      // REQ-008: Missing or non-string phase -- fail-open
      process.exit(0);
    }

    const requiredDispatches = STOP_PHASE_REQUIREMENTS[currentPhase] || [];

    if (requiredDispatches.length === 0) {
      // REQ-002/REQ-003: Pre-implementation or implementation phase -- no dispatches required
      process.exit(0);
    }

    const allTasks = getAllTasks(session);
    const missingDispatches = [];

    for (const requiredType of requiredDispatches) {
      // AC-4.11: Any status satisfies (presence check only)
      const found = allTasks.some(t => t.subagent_type === requiredType);
      if (!found) {
        missingDispatches.push(requiredType);
      }
    }

    if (missingDispatches.length === 0) {
      // AC-4.5: All mandatory dispatches present -- allow completion
      safeDelete(sentinelPath);
      process.exit(0);
    }

    // Step 8: Check for stop-gate override
    const overridePath = join(coordinationDir, OVERRIDE_FILENAME);
    const overrides = loadOverrides(overridePath);

    if (overrides) {
      const stopOverride = findMatchingOverride(overrides, OVERRIDE_GATE_NAMES.stop_mandatory_dispatches, sessionId);
      if (stopOverride) {
        // Override honored -- allow completion
        safeDelete(sentinelPath);
        process.exit(0);
      }
    }

    // Step 9: Block session completion
    // Create sentinel BEFORE outputting block decision (AC-4.6)
    try {
      writeFileSync(sentinelPath, new Date().toISOString());
    } catch {
      // If we can't create the sentinel, proceed with block anyway
      // Worst case: one more re-trigger cycle
    }

    // AC-4.10: Block via stdout JSON, NOT stderr + exit 2
    const reason = `Missing mandatory dispatches: ${missingDispatches.join(', ')}. ` +
      `Dispatch these subagent types before completing the session. ` +
      `To override: add { "gate": "stop_mandatory_dispatches", "session_id": "${sessionId}", ` +
      `"timestamp": "${new Date().toISOString()}", "rationale": "..." } to .claude/coordination/gate-override.json`;

    console.log(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
  } catch (err) {
    // Fail-open on any error
    process.stderr.write(`Error in workflow-stop-enforcement hook: ${err.message}\n`);
    process.exit(0);
  }
}

main();
