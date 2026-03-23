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
 * Note: awaiting_approval is NOT in any mandatory check list (AC-1.13).
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

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  STOP_MANDATORY_DISPATCHES,
  STOP_PHASE_REQUIREMENTS,
  OVERRIDE_GATE_NAMES,
  getWorkflowTypeStrict,
  isExemptWorkflow,
  getAllTasks,
  validateObligations,
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
    const currentPhase = session.active_work.current_phase;

    if (!currentPhase || typeof currentPhase !== 'string') {
      // REQ-008: Missing or non-string phase -- fail-open
      process.exit(0);
    }

    const requiredDispatches = STOP_PHASE_REQUIREMENTS[currentPhase] || [];

    const allTasks = getAllTasks(session);
    const missingDispatches = [];

    for (const requiredType of requiredDispatches) {
      // AC-4.11: Any status satisfies (presence check only)
      const found = allTasks.some(t => t.subagent_type === requiredType);
      if (!found) {
        missingDispatches.push(requiredType);
      }
    }

    // Step 7.5: Manifest status obligation check (status-obligation-enforcement)
    // Implements: REQ-006, REQ-007, REQ-008, REQ-009, REQ-010, REQ-013, REQ-014, REQ-015
    let obligationViolations = [];
    let obligationOverridden = false;

    const specGroupId = session.active_work?.spec_group_id;
    if (specGroupId) {
      // SEC-001: Validate spec_group_id format before constructing file path
      if (!/^sg-[a-z0-9-]+$/.test(specGroupId)) {
        process.stderr.write(`Warning: Invalid spec_group_id format '${specGroupId}' -- obligation check skipped\n`);
      } else {
      const manifestPath = join(claudeDir, 'specs', 'groups', specGroupId, 'manifest.json');
      try {
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

          // AC-5.4: Identify skipped phases from session history (exclude from validation)
          const skippedPhases = (session.history || [])
            .filter(h => h.event_type === 'override_skip')
            .map(h => h.details?.phase)
            .filter(Boolean);

          // Only check obligations for current phase if it wasn't skipped
          if (!skippedPhases.includes(currentPhase)) {
            // Check for phase-scoped override (REQ-014)
            const overrideGateName = `status_obligations:${currentPhase}`;
            const overridePath = join(coordinationDir, OVERRIDE_FILENAME);
            const overrides = loadOverrides(overridePath);

            if (overrides) {
              // CR-H1: Use spec_group_id for override matching (AC-8.5), consistent with session-checkpoint.mjs
              const obligationOverride = findMatchingOverride(overrides, overrideGateName, specGroupId);
              if (obligationOverride) {
                obligationOverridden = true;
              }
            }

            if (!obligationOverridden) {
              const result = validateObligations(currentPhase, manifest);
              if (!result.passed) {
                obligationViolations = result.violations;
              }
            }
          }
        } else {
          // AC-7.1: Missing manifest -- fail-open with warning
          process.stderr.write(`Warning: Obligation check skipped -- manifest not found at ${manifestPath}\n`);
        }
      } catch (err) {
        // Fail-open on structural errors (malformed JSON, read failure)
        process.stderr.write(`Warning: Obligation check skipped: ${err.message}\n`);
      }
      } // end SEC-001 else block
    }
    // No spec_group_id: obligation check skipped silently (REQ-009, AC-6.5)

    // Step 7.6: Determine enforcement level for obligation violations
    // Read enforcement_level directly from session.phase_checkpoint (not a shared function).
    // Default to 'graduated' when phase_checkpoint is null (e.g., after complete-work).
    const enforcementLevel = session.phase_checkpoint?.enforcement_level || 'graduated';

    // If no dispatch violations and no obligation violations, allow completion
    if (missingDispatches.length === 0 && obligationViolations.length === 0) {
      safeDelete(sentinelPath);
      process.exit(0);
    }

    // Step 8: Check for stop-gate dispatch override
    const overridePath = join(coordinationDir, OVERRIDE_FILENAME);
    const overrides = loadOverrides(overridePath);
    let dispatchOverridden = false;

    if (overrides && missingDispatches.length > 0) {
      const stopOverride = findMatchingOverride(overrides, OVERRIDE_GATE_NAMES.stop_mandatory_dispatches, sessionId);
      if (stopOverride) {
        dispatchOverridden = true;
      }
    }

    // If both dispatch and obligation issues are overridden/resolved, allow
    if (dispatchOverridden && obligationViolations.length === 0) {
      safeDelete(sentinelPath);
      process.exit(0);
    }

    // Determine what to block/warn about
    const hasDispatchIssues = missingDispatches.length > 0 && !dispatchOverridden;
    const hasObligationIssues = obligationViolations.length > 0;

    // Handle obligation violations based on enforcement level (AC-5.5)
    if (hasObligationIssues && enforcementLevel === 'warn-only') {
      // Log warnings to stderr but do NOT block for obligations (AC-5.5)
      const violationLines = obligationViolations.map(
        v => `  - ${v.field}: expected ${JSON.stringify(v.expected)}, actual ${v.actual === null ? 'null (not set)' : JSON.stringify(v.actual)}`
      ).join('\n');
      process.stderr.write(
        `Warning: Manifest status inconsistency (warn-only mode):\n${violationLines}\n`
      );

      // Record warned violation events in session.json (REQ-015)
      try {
        const sessionPath = join(claudeDir, 'context', 'session.json');
        const freshSession = loadSession(sessionPath);
        if (freshSession) {
          for (const v of obligationViolations) {
            freshSession.history = freshSession.history || [];
            freshSession.history.push({
              timestamp: new Date().toISOString(),
              event_type: 'obligation_violation',
              details: {
                phase: currentPhase,
                field: v.field,
                expected_value: v.expected,
                actual_value: v.actual,
                resolution: 'warned',
              },
            });
          }
          freshSession.updated_at = new Date().toISOString();
          // CR-M2/SEC-003: Atomic write-to-temp-then-rename to prevent partial writes
          const tmpPath = sessionPath + '.tmp.' + process.pid;
          writeFileSync(tmpPath, JSON.stringify(freshSession, null, 2) + '\n');
          renameSync(tmpPath, sessionPath);
        }
      } catch {
        // Fail-open on session write errors
      }

      // If no dispatch issues remain, allow completion
      if (!hasDispatchIssues) {
        safeDelete(sentinelPath);
        process.exit(0);
      }
    }

    // Record blocked obligation violation events in session.json (REQ-015)
    if (hasObligationIssues && enforcementLevel === 'graduated') {
      try {
        const sessionPath = join(claudeDir, 'context', 'session.json');
        const freshSession = loadSession(sessionPath);
        if (freshSession) {
          for (const v of obligationViolations) {
            freshSession.history = freshSession.history || [];
            freshSession.history.push({
              timestamp: new Date().toISOString(),
              event_type: 'obligation_violation',
              details: {
                phase: currentPhase,
                field: v.field,
                expected_value: v.expected,
                actual_value: v.actual,
                resolution: 'blocked',
              },
            });
          }
          freshSession.updated_at = new Date().toISOString();
          // CR-M2/SEC-003: Atomic write-to-temp-then-rename to prevent partial writes
          const tmpPath2 = sessionPath + '.tmp.' + process.pid;
          writeFileSync(tmpPath2, JSON.stringify(freshSession, null, 2) + '\n');
          renameSync(tmpPath2, sessionPath);
        }
      } catch {
        // Fail-open on session write errors
      }
    }

    // Step 9: Block session completion
    // Build combined block message (AC-5.2: clearly distinguish dispatch vs obligation blocks)
    const reasonParts = [];

    if (hasDispatchIssues) {
      reasonParts.push(`Missing mandatory dispatches: ${missingDispatches.join(', ')}.`);
    }

    if (hasObligationIssues && enforcementLevel === 'graduated') {
      const violationLines = obligationViolations.map(
        v => `  - ${v.field}: expected ${JSON.stringify(v.expected)}, actual ${v.actual === null ? 'null (not set)' : JSON.stringify(v.actual)}`
      ).join('\n');
      reasonParts.push(`Manifest status inconsistency:\n${violationLines}`);
    }

    // If nothing to block (e.g., obligations were warn-only and dispatch had issues)
    if (reasonParts.length === 0) {
      safeDelete(sentinelPath);
      process.exit(0);
    }

    // Build specific remediation guidance
    const remediationParts = [];
    if (hasDispatchIssues) {
      const skillMap = {
        'code-reviewer': '/code-review',
        'security-reviewer': '/security',
        'completion-verifier': 'completion-verifier agent (dispatch directly)',
        'documenter': '/docs',
      };
      const skillInstructions = missingDispatches
        .map(d => `  - ${d}: Run ${skillMap[d] || d}`)
        .join('\n');
      remediationParts.push(`Dispatch the following subagent types:\n${skillInstructions}`);
    }
    if (hasObligationIssues && enforcementLevel === 'graduated') {
      const obligationInstructions = obligationViolations.map(v => {
        if (v.field.startsWith('convergence.')) {
          const gate = v.field.replace('convergence.', '').replace('_passed', '').replace('_converged', '');
          return `  - ${v.field}: Run the convergence loop, then: node .claude/scripts/session-checkpoint.mjs update-convergence ${gate} 2`;
        }
        return `  - ${v.field}: Update manifest.json to set ${v.field} = ${JSON.stringify(v.expected)}`;
      }).join('\n');
      remediationParts.push(`Update manifest fields:\n${obligationInstructions}`);
    }
    reasonParts.push(
      'How to unblock:\n' + remediationParts.join('\n')
    );

    // Create sentinel BEFORE outputting block decision (AC-4.6)
    try {
      writeFileSync(sentinelPath, new Date().toISOString());
    } catch {
      // If we can't create the sentinel, proceed with block anyway
      // Worst case: one more re-trigger cycle
    }

    // AC-4.10: Block via stdout JSON, NOT stderr + exit 2
    const reason = reasonParts.join('\n\n');
    console.log(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
  } catch (err) {
    // Fail-open on any error
    process.stderr.write(`Error in workflow-stop-enforcement hook: ${err.message}\n`);
    process.exit(0);
  }
}

main();
