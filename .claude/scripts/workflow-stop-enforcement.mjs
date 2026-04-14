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
 *   5. e2e-test-writer (unless spec opts out via e2e_skip: true)
 *
 * Note: awaiting_approval is NOT in any mandatory check list (AC-1.13).
 *
 * Additional gates:
 *   6. Deployment verification (sg-deployment-verification-gaps):
 *      Blocks when deployment.detected=true AND deployment.failed!=true
 *      AND deployment.verify_deploy_passed!=true.
 *      verify_build_passed is advisory only (not checked).
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

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, basename } from 'node:path';
import {
  STOP_MANDATORY_DISPATCHES,
  STOP_PHASE_REQUIREMENTS,
  VALID_E2E_SKIP_RATIONALES,
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
import { atomicModifyJSON } from './lib/atomic-write.mjs';

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

    // Step 7.4: E2E opt-out recognition (sg-e2e-default-dispatch)
    // If e2e-test-writer is missing, check spec frontmatter for opt-out.
    // Data-flow: session.json -> spec_group_id -> convention-based spec path -> frontmatter.
    const e2eIdx = missingDispatches.indexOf('e2e-test-writer');
    if (e2eIdx !== -1) {
      const sgId = session.active_work?.spec_group_id;
      let e2eOptedOut = false;

      if (sgId && /^sg-[a-z0-9-]+$/.test(sgId)) {
        try {
          const sgDir = join(claudeDir, 'specs', 'groups', sgId);

          // Check for orchestrator workflows with atomic specs
          const atomicDir = join(sgDir, 'atomic');
          let specFiles = [];

          if (existsSync(atomicDir)) {
            // Orchestrator: glob atomic/*.md for per-spec checking (AC-5.1)
            try {
              const atomicEntries = readdirSync(atomicDir).filter(f => f.endsWith('.md'));
              specFiles = atomicEntries.map(f => join(atomicDir, f));
            } catch {
              // AC-9.3: glob returns empty/fails -> fail-open (structural error)
              e2eOptedOut = false;
            }
          }

          if (specFiles.length === 0) {
            // Oneoff-spec: single spec path (convention-based)
            const specPath = join(sgDir, 'spec.md');
            specFiles = [specPath];
          }

          // Per-spec checking: each spec evaluated individually (AC-5.4)
          let allSpecsSatisfied = true;
          const optOutRecords = [];

          for (const specFile of specFiles) {
            if (!existsSync(specFile)) {
              // AC-9.1/AC-9.3: spec file not found -> fail-open (structural error)
              continue;
            }

            try {
              const specContent = readFileSync(specFile, 'utf8');
              const fmMatch = specContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);

              if (!fmMatch) {
                // No frontmatter -> fail-closed: treat as e2e required (AC-9.2)
                allSpecsSatisfied = false;
                continue;
              }

              // Parse e2e_skip from frontmatter
              const fmLines = fmMatch[1].split('\n');
              let e2eSkipRaw = undefined;
              let e2eSkipRationale = undefined;

              for (const line of fmLines) {
                const colonIdx = line.indexOf(':');
                if (colonIdx === -1) continue;
                const key = line.slice(0, colonIdx).trim();
                const val = line.slice(colonIdx + 1).trim();
                if (key === 'e2e_skip') e2eSkipRaw = val;
                if (key === 'e2e_skip_rationale') e2eSkipRationale = val;
              }

              // AC-3.1: Strict boolean validation
              // YAML booleans true/false are parsed as strings by simple frontmatter parsers.
              // Accept only literal "true" or "false" (strict YAML boolean representation).
              if (e2eSkipRaw === 'true') {
                // AC-2.3: Defense-in-depth rationale validation (independent of spec-validate)
                if (e2eSkipRationale && VALID_E2E_SKIP_RATIONALES.includes(e2eSkipRationale)) {
                  // Valid opt-out (AC-2.2)
                  const specId = basename(specFile, '.md');
                  optOutRecords.push({
                    type: 'e2e_opt_out',
                    spec_id: specId,
                    e2e_skip: true,
                    rationale: e2eSkipRationale,
                    timestamp: new Date().toISOString(),
                  });
                } else {
                  // Invalid rationale -> fail-closed (treat as e2e required)
                  allSpecsSatisfied = false;
                }
              } else if (e2eSkipRaw === undefined) {
                // AC-9.2: e2e_skip missing -> fail-closed (treat as e2e required)
                // Check if this spec has a dispatch record instead
                const specId = basename(specFile, '.md');
                const hasDispatch = allTasks.some(t => t.subagent_type === 'e2e-test-writer');
                if (!hasDispatch) {
                  allSpecsSatisfied = false;
                }
              } else if (e2eSkipRaw === 'false' || e2eSkipRaw === '') {
                // EC-3: e2e_skip: false -> same as absent, e2e required
                const hasDispatch = allTasks.some(t => t.subagent_type === 'e2e-test-writer');
                if (!hasDispatch) {
                  allSpecsSatisfied = false;
                }
              } else {
                // AC-3.1: Non-boolean values ("yes", "1", string "true" with quotes) -> fail-closed
                allSpecsSatisfied = false;
              }
            } catch {
              // AC-9.1: Spec file read error -> fail-open (structural error)
              continue;
            }
          }

          if (allSpecsSatisfied) {
            e2eOptedOut = true;
            // AC-6.1, AC-6.2: Log structured opt-out records in session.json
            if (optOutRecords.length > 0) {
              try {
                const sessionWritePath = join(claudeDir, 'context', 'session.json');
                atomicModifyJSON(sessionWritePath, (current) => {
                  const s = current || {};
                  s.e2e_opt_outs = s.e2e_opt_outs || [];
                  s.e2e_opt_outs.push(...optOutRecords);
                  s.updated_at = new Date().toISOString();
                  return s;
                });
              } catch {
                // Fail-open on session write errors
              }
            }
          }
        } catch {
          // AC-9.1: Structural error -> fail-open (don't require e2e)
          e2eOptedOut = true;
        }
      } else if (!sgId) {
        // No spec_group_id -> fail-open
        e2eOptedOut = true;
      }
      // Invalid sgId format -> fail-open (structural error)
      else {
        e2eOptedOut = true;
      }

      if (e2eOptedOut) {
        missingDispatches.splice(e2eIdx, 1);
      }
    }

    // Step 7.5: Shared manifest read (CR-M2: avoid redundant I/O)
    // Both obligation check and PRD staleness check use the same manifest.
    // Read it once here and reuse the parsed object in both code paths.
    const specGroupId = session.active_work?.spec_group_id;
    let sharedManifest = null;
    let manifestReadFailed = false;

    if (specGroupId) {
      // SEC-001: Validate spec_group_id format before constructing file path
      if (!/^sg-[a-z0-9-]+$/.test(specGroupId)) {
        process.stderr.write(`Warning: Invalid spec_group_id format '${specGroupId}' -- manifest checks skipped\n`);
        manifestReadFailed = true;
      } else {
        const manifestPath = join(claudeDir, 'specs', 'groups', specGroupId, 'manifest.json');
        try {
          if (existsSync(manifestPath)) {
            sharedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
          } else {
            // AC-7.1: Missing manifest -- fail-open with warning
            process.stderr.write(`Warning: Manifest not found at ${manifestPath}\n`);
            manifestReadFailed = true;
          }
        } catch (err) {
          // Fail-open on structural errors (malformed JSON, read failure)
          process.stderr.write(`Warning: Manifest read failed: ${err.message}\n`);
          manifestReadFailed = true;
        }
      }
    }

    // Step 7.5a: Manifest status obligation check (status-obligation-enforcement)
    // Implements: REQ-006, REQ-007, REQ-008, REQ-009, REQ-010, REQ-013, REQ-014, REQ-015
    let obligationViolations = [];
    let obligationOverridden = false;

    // Guard: Only validate obligations when currentPhase is 'complete'.
    // Active phases (implementing, reviewing, etc.) skip obligation validation entirely --
    // session-checkpoint.mjs handles obligation enforcement at phase transitions.
    // Unrecognized phase strings also skip (fail-open, consistent with REQ-018).
    if (currentPhase === 'complete' && specGroupId && sharedManifest) {
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
          const result = validateObligations(currentPhase, sharedManifest);
          if (!result.passed) {
            obligationViolations = result.violations;
          }
        }
      }
    }
    // No specGroupId or manifest: obligation check skipped silently (REQ-009, AC-6.5)

    // Step 7.6: Determine enforcement level for obligation violations
    // Read enforcement_level directly from session.phase_checkpoint (not a shared function).
    // Default to 'graduated' when phase_checkpoint is null (e.g., after complete-work).
    const enforcementLevel = session.phase_checkpoint?.enforcement_level || 'graduated';

    // Step 7.7: PRD staleness check (REQ-002, AC-2.1 through AC-2.7)
    // Only check when work_state is READY_TO_MERGE. Warning only, never blocks.
    // CR-M2: Reuses sharedManifest from Step 7.5 instead of re-reading.
    let prdWarning = '';
    try {
      if (specGroupId && sharedManifest && !manifestReadFailed) {
        if (sharedManifest.work_state === 'READY_TO_MERGE') {
          // AC-2.1, AC-2.7: Locate PRD via manifest.prd.file_path || manifest.prd.prd_path
          let prdPath = sharedManifest.prd?.file_path || sharedManifest.prd?.prd_path || null;

          // AC-2.6: Fall back to requirements.md prd_path frontmatter
          if (!prdPath) {
            try {
              const reqPath = join(claudeDir, 'specs', 'groups', specGroupId, 'requirements.md');
              if (existsSync(reqPath)) {
                const reqContent = readFileSync(reqPath, 'utf8');
                const fmMatch = reqContent.match(/^---\n([\s\S]*?)\n---/);
                if (fmMatch) {
                  const prdPathMatch = fmMatch[1].match(/^prd_path:\s*(.+)$/m);
                  if (prdPathMatch) {
                    prdPath = prdPathMatch[1].trim();
                  }
                }
              }
            } catch {
              // Fail-open: requirements.md parsing error
            }
          }

          // AC-2.3: No PRD linked -- skip silently
          if (prdPath) {
            // CR-H1: Validate PRD path against path traversal (defense-in-depth)
            if (prdPath.includes('..') || isAbsolute(prdPath)) {
              // Skip PRD check for suspicious paths
              process.stderr.write(`Warning: PRD path rejected (path traversal check): ${prdPath}\n`);
            } else {
              // Resolve PRD path relative to project root (parent of .claude dir)
              const projectRoot = join(claudeDir, '..');
              const resolvedPrdPath = join(projectRoot, prdPath);

              // Secondary containment: ensure resolved path stays within project root
              if (!resolvedPrdPath.startsWith(projectRoot)) {
                process.stderr.write(`Warning: PRD path escaped project root: ${prdPath}\n`);
              } else {
                // AC-2.4: PRD file does not exist -- skip silently
                if (existsSync(resolvedPrdPath)) {
                  const prdContent = readFileSync(resolvedPrdPath, 'utf8');
                  const prdFmMatch = prdContent.match(/^---\n([\s\S]*?)\n---/);
                  if (prdFmMatch) {
                    const stateMatch = prdFmMatch[1].match(/^state:\s*(.+)$/m);
                    if (stateMatch) {
                      const prdState = stateMatch[1].trim();
                      // AC-2.1: Warn when state is draft; AC-2.2: Skip when non-draft
                      if (prdState === 'draft') {
                        prdWarning = `WARNING: Linked PRD is still in "draft" state: ${prdPath}. ` +
                          `Consider promoting it before merge with: /prd status <prd-id>`;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // AC-2.5: Fail-open -- any PRD check error must not block session
    }

    // Step 7.8: Deployment verification gate (sg-deployment-verification-gaps)
    // Implements: AC-5.1 through AC-5.4, AC-6.3, AC-6.4
    // Check: deployment detected -> must have post-deploy verification
    // verify_build_passed is NOT checked (advisory only, AC-5.4)
    let deploymentBlocked = false;
    let deploymentBlockReason = '';

    try {
      const deployment = session.deployment;

      if (deployment !== undefined && deployment !== null) {
        // AC-6.3: Validate deployment is an object (fail-open on non-object)
        if (typeof deployment !== 'object' || Array.isArray(deployment)) {
          process.stderr.write(
            `[workflow-enforcement] WARNING: Malformed deployment object (type: ${typeof deployment}) -- fail-open\n`
          );
          // Structural error: fail-open, do not block
        } else {
          // AC-6.3: Validate field types are boolean independently (fail-open on non-boolean).
          // Each field is checked separately so a malformed `detected` does not
          // short-circuit validation of `failed` and `verify_deploy_passed` (chk-impl-c4d8a2e1).
          const detected = deployment.detected;
          const failed = deployment.failed;
          const verifyDeployPassed = deployment.verify_deploy_passed;

          let hasStructuralError = false;

          if (detected !== undefined && typeof detected !== 'boolean') {
            process.stderr.write(
              `[workflow-enforcement] WARNING: deployment.detected is not boolean (${typeof detected}) -- fail-open\n`
            );
            hasStructuralError = true;
          }
          if (failed !== undefined && typeof failed !== 'boolean') {
            process.stderr.write(
              `[workflow-enforcement] WARNING: deployment.failed is not boolean (${typeof failed}) -- fail-open\n`
            );
            hasStructuralError = true;
          }
          if (verifyDeployPassed !== undefined && typeof verifyDeployPassed !== 'boolean') {
            process.stderr.write(
              `[workflow-enforcement] WARNING: deployment.verify_deploy_passed is not boolean (${typeof verifyDeployPassed}) -- fail-open\n`
            );
            hasStructuralError = true;
          }

          if (hasStructuralError) {
            // Any non-boolean field is a structural error: fail-open, do not block
          } else {
            // AC-6.4: Missing/undefined deployment.detected treated as false (no deployment)
            if (detected === true) {
              // AC-5.3: deployment.failed=true takes absolute precedence
              if (failed === true) {
                // No artifact to verify -- skip verification gate
                process.stderr.write(
                  '[workflow-enforcement] Deployment failed -- verification gate skipped (no artifact to verify)\n'
                );
              } else if (verifyDeployPassed !== true) {
                // AC-5.1: Block -- deployment detected without post-deploy verification
                deploymentBlocked = true;
                deploymentBlockReason =
                  'Deployment detected without post-deploy verification. Run smoke test before completing session.';
              }
              // else: AC-5.2 -- verify_deploy_passed=true, gate passes
            }
            // else: No deployment detected (AC-6.4) -- gate passes
          }
        }
      }
      // deployment field absent -- no deployment detected (AC-6.4), gate passes
    } catch (err) {
      // AC-6.3: Fail-open on any structural error in deployment gate
      process.stderr.write(
        `[workflow-enforcement] WARNING: Deployment gate structural error: ${err.message} -- fail-open\n`
      );
    }

    // If no dispatch violations, no obligation violations, and no deployment block, allow completion
    if (missingDispatches.length === 0 && obligationViolations.length === 0 && !deploymentBlocked) {
      safeDelete(sentinelPath);
      // AC-2.1: Emit PRD warning via additionalContext if present
      if (prdWarning) {
        console.log(JSON.stringify({ additionalContext: prdWarning }));
      }
      process.exit(0);
    }

    // Step 8: Check for stop-gate dispatch override
    const overridePath = join(coordinationDir, OVERRIDE_FILENAME);
    let dispatchOverridden = false;

    if (missingDispatches.length > 0 && existsSync(overridePath)) {
      // Support two override formats:
      // 1. Array format: { "overrides": [{ gate, session_id, timestamp, rationale }] }
      // 2. Flat-key format: { "stop_mandatory_dispatches": { session_id, timestamp, rationale } }
      const overrides = loadOverrides(overridePath);
      if (overrides) {
        const stopOverride = findMatchingOverride(overrides, OVERRIDE_GATE_NAMES.stop_mandatory_dispatches, sessionId);
        if (stopOverride) {
          dispatchOverridden = true;
        }
      }

      // Flat-key format fallback (AC-4.1)
      if (!dispatchOverridden) {
        try {
          const rawOverride = JSON.parse(readFileSync(overridePath, 'utf8'));
          const gateName = OVERRIDE_GATE_NAMES.stop_mandatory_dispatches;
          if (rawOverride && rawOverride[gateName] && typeof rawOverride[gateName] === 'object') {
            const entry = rawOverride[gateName];
            if (entry.rationale && entry.timestamp) {
              dispatchOverridden = true;
            }
          }
        } catch {
          // Fail-open on parse error
        }
      }
    }

    // If both dispatch and obligation issues are overridden/resolved, and no deployment block, allow
    if (dispatchOverridden && obligationViolations.length === 0 && !deploymentBlocked) {
      safeDelete(sentinelPath);
      if (prdWarning) {
        console.log(JSON.stringify({ additionalContext: prdWarning }));
      }
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
        const sessionWritePath = join(claudeDir, 'context', 'session.json');
        atomicModifyJSON(sessionWritePath, (current) => {
          const s = current || {};
          for (const v of obligationViolations) {
            s.history = s.history || [];
            s.history.push({
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
          s.updated_at = new Date().toISOString();
          return s;
        });
      } catch {
        // Fail-open on session write errors
      }

      // If no dispatch issues remain and no deployment block, allow completion
      if (!hasDispatchIssues && !deploymentBlocked) {
        safeDelete(sentinelPath);
        if (prdWarning) {
          console.log(JSON.stringify({ additionalContext: prdWarning }));
        }
        process.exit(0);
      }
    }

    // Record blocked obligation violation events in session.json (REQ-015)
    if (hasObligationIssues && enforcementLevel === 'graduated') {
      try {
        const sessionWritePath = join(claudeDir, 'context', 'session.json');
        atomicModifyJSON(sessionWritePath, (current) => {
          const s = current || {};
          for (const v of obligationViolations) {
            s.history = s.history || [];
            s.history.push({
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
          s.updated_at = new Date().toISOString();
          return s;
        });
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

    // Step 9.1: Deployment verification block (sg-deployment-verification-gaps)
    if (deploymentBlocked) {
      reasonParts.push(deploymentBlockReason);
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
        'e2e-test-writer': '/e2e-test (or add e2e_skip: true with valid rationale to spec frontmatter)',
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
          return `  - ${v.field}: Run the convergence loop, then: node .claude/scripts/session-checkpoint.mjs update-convergence ${gate}`;
        }
        return `  - ${v.field}: Update manifest.json to set ${v.field} = ${JSON.stringify(v.expected)}`;
      }).join('\n');
      remediationParts.push(`Update manifest fields:\n${obligationInstructions}`);
    }
    if (deploymentBlocked) {
      remediationParts.push(
        'Run post-deploy verification:\n' +
        '  - Execute: npm run verify:deploy <endpoint-url>\n' +
        '  - Or use HTTP GET fallback with endpoint URL\n' +
        '  - Or call: node .claude/scripts/session-checkpoint.mjs record-deployment-failure (if deployment failed)'
      );
    }
    if (remediationParts.length > 0) {
      reasonParts.push(
        'How to unblock:\n' + remediationParts.join('\n')
      );
    }

    // Create sentinel BEFORE outputting block decision (AC-4.6)
    try {
      mkdirSync(coordinationDir, { recursive: true });
      writeFileSync(sentinelPath, new Date().toISOString());
    } catch {
      // If we can't create the sentinel, proceed with block anyway
      // Worst case: one more re-trigger cycle
    }

    // AC-4.10: Block via stdout JSON, NOT stderr + exit 2
    const reason = reasonParts.join('\n\n');
    const blockOutput = { decision: 'block', reason };
    // Include PRD warning alongside block decision if present
    if (prdWarning) {
      blockOutput.additionalContext = prdWarning;
    }
    console.log(JSON.stringify(blockOutput));
    process.exit(0);
  } catch (err) {
    // Fail-open on any error
    process.stderr.write(`Error in workflow-stop-enforcement hook: ${err.message}\n`);
    process.exit(0);
  }
}

main();
