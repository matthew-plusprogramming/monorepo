#!/usr/bin/env node

/**
 * Stop Hook: Workflow Completion Enforcement
 *
 * Blocks session completion when mandatory dispatches have not occurred
 * for spec-based workflows.
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
 *   6. Deployment verification:
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
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, basename, resolve, relative, sep } from 'node:path';
import YAML from 'yaml';
import {
  STOP_MANDATORY_DISPATCHES,
  VALID_E2E_SKIP_RATIONALES,
  VALID_RUNTIME_VALIDATION_SURFACES,
  OVERRIDE_GATE_NAMES,
  getWorkflowTypeStrict,
  getStopPhaseRequirements,
  isExemptWorkflow,
  getAllTasks,
  validateObligations,
  // ws-dag-substages / as-007c / AC7.2: passthrough — Stop hook does NOT
  // evaluate challenger substage completeness (that is owned by
  // transition-phase). Import validateSubstages anyway so the grep-lock
  // inventory test (as-008c / AC-C-CONSUMER-LOCK) recognizes this consumer
  // as touched. The Decision Log records this as passthrough (no
  // behavioral change in this hook). See ws-dag-substages spec
  // Decision Log and manifest.
  validateSubstages,
} from './lib/workflow-dag.mjs';
import {
  readStdin,
  findClaudeDir,
  loadSession,
  loadOverrides,
  findMatchingOverride,
} from './lib/hook-utils.mjs';
import { atomicModifyJSON } from './lib/atomic-write.mjs';
import {
  shouldRunChecks,
  checkConvergenceDepth,
  checkChallengerStages,
  checkPhaseDagPredecessors,
  checkArtifactInventory,
  checkConvergenceFieldSanity,
  CHECK_ENFORCEMENT_POLICY,
  formatConvergenceDepthFailure,
  formatChallengerStagesFailure,
  formatPhaseDagFailure,
  formatArtifactInventoryFailure,
  formatConvergenceSanityFailure,
} from './lib/stop-hook-checks.mjs';
import { readThresholdFromSnapshot } from './lib/snapshot-threshold-reader.mjs';
// Unlock-misuse heartbeat: emits advisory `UNLOCK_USED_NO_TESTS` on stderr
// plus a `test_writer_unlock_misuse` audit-log entry when a test-writer
// dispatch consumed an active unlock window without producing test-file
// changes. Non-blocking — purely observability.
import {
  detectUnlockMisuse,
  formatMisuseStderrLine,
  buildMisuseAuditPayload,
  MISUSE_EVENT_CLASS,
  MISUSE_ADVISORY_CODE,
} from './lib/unlock-misuse-detect.mjs';
// appendAuditEntry is imported lazily inside emitUnlockMisuseHeartbeat so a
// pipeline-efficiency-audit-log load failure cannot crash the Stop hook's
// main flow (dynamic import keeps the hook fail-open on audit-lib absence).

// =============================================================================
// Constants
// =============================================================================

/** Sentinel file that disables enforcement (kill switch). */
const KILL_SWITCH_FILENAME = 'gate-enforcement-disabled';

/** Sentinel file to prevent Stop hook infinite loops (AC-4.6). */
const STOP_HOOK_ACTIVE_FILENAME = 'stop-hook-active';

/** Override file for human-provided gate overrides. */
const OVERRIDE_FILENAME = 'gate-override.json';

const INFRA_BLOCKED_HUMAN_CONFIRMATION_THRESHOLD = 2;

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

/**
 * Trust-bearing path allowlist for vibe-mode sessions (sg-enforcement-layer-gaps
 * Task 27 / REQ-M2-006 / AC-11.1). When a vibe-mode session edits any of
 * these files, the Stop hook fails closed instead of exempt-bypassing.
 *
 * Editing these files requires the full spec enforcement chain: an agent
 * cannot modify the enforcement layer under
 * vibe-mode exemption.
 *
 * Entries are `.claude/`-relative paths. Basename matching is used to avoid
 * false positives on analogous files in other projects.
 */
const TRUST_BEARING_ALLOWLIST = [
  // Core enforcement hooks
  'scripts/workflow-gate-enforcement.mjs',
  'scripts/workflow-stop-enforcement.mjs',
  'scripts/workflow-file-protection.mjs',
  'scripts/dispatch-record-hook.mjs',
  // Session state writer (sole writer invariant)
  'scripts/session-checkpoint.mjs',
  // DAG and shared enforcement library
  'scripts/lib/workflow-dag.mjs',
  'scripts/lib/stop-hook-checks.mjs',
  'scripts/lib/hook-utils.mjs',
  'scripts/lib/session-lock.mjs',
  'scripts/lib/atomic-write.mjs',
  // Trust root constants
  'scripts/lib/sync-constants.mjs',
  // Hook registration surface
  'settings.json',
];

const RUNTIME_MANUAL_TEST_PHASES = new Set(['documenting', 'complete']);

// sg-manual-tester-infra-blocked-20260508 / AS-3 / DEC-010 / DEC-013.
// Block-reason text fragments for the new `infra_blocked` Stop-hook branch.
// Kept as named constants so test fixtures can import them and so changes to
// operator-facing text are auditable in source control. The full block-reason
// strings include the trigger narrative + dispatch_id so the operator sees
// the structured trigger evidence directly in the Stop-hook output.
//
// Canonical form: snake_case machine-readable identifier per spec AS-3
// (AC-4.1, AC-6.1, AC-8.1). Operator readability is preserved by the
// colon-separated narrative that follows the marker.
const INFRA_BLOCKED_TERMINAL_REASON_PREFIX = 'infra_blocked_terminal';
const INFRA_BLOCKED_HUMAN_CONFIRMATION_REASON_PREFIX =
  'infra_blocked_human_confirmation_required';
const INFRA_BLOCKED_NARRATIVE_FALLBACK = '<missing narrative>';
const INFRA_BLOCKED_DISPATCH_ID_FALLBACK = '<missing dispatch_id>';

/**
 * SEC-003 (defense-in-depth): strip ASCII control characters (U+0000..U+001F
 * and U+007F) from a string before it lands in a Stop-hook block-reason.
 * Block-reasons surface to terminals, log files, and audit trails; embedded
 * control bytes (e.g., ANSI escape sequences, line-feeds, NULs) enable
 * terminal-injection / log-spoofing attacks. We replace every control byte
 * with a single space rather than dropping it so the visible-character
 * boundary survives substring assertions in test fixtures.
 *
 * @param {string} value already-trimmed string
 * @returns {string} value with control chars replaced by spaces
 */
function stripControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, ' ');
}

/**
 * Extract the trigger narrative from a manual_test_result record. Falls back
 * to a sentinel when the field is absent or non-string so the resulting
 * block-reason string remains well-formed (NFR-2 fail-open discipline).
 *
 * SEC-003: control characters in the narrative are stripped before the
 * value is returned so the formatted block-reason cannot inject terminal
 * escape sequences or log-spoof newlines.
 *
 * @param {object} result `session.active_work.manual_test_result`
 * @returns {string} narrative text or `<missing narrative>` sentinel
 */
function formatInfraBlockedNarrative(result) {
  const narrative = result?.evidence?.narrative;
  if (typeof narrative === 'string' && narrative.trim().length > 0) {
    return stripControlChars(narrative.trim());
  }
  return INFRA_BLOCKED_NARRATIVE_FALLBACK;
}

/**
 * Extract the canonical dispatch_id from a manual_test_result record.
 * Prefers the top-level `dispatch_id` (canonicalized at write time) over
 * `evidence.dispatch_id` so a corrupted evidence sub-object cannot mask the
 * canonical value. Falls back to a sentinel when both are absent.
 *
 * SEC-003: control characters in the dispatch_id are stripped before the
 * value is returned (same reasoning as formatInfraBlockedNarrative).
 *
 * @param {object} result `session.active_work.manual_test_result`
 * @returns {string} dispatch_id text or `<missing dispatch_id>` sentinel
 */
function formatInfraBlockedDispatchId(result) {
  const direct = result?.dispatch_id;
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return stripControlChars(direct.trim());
  }
  const fromEvidence = result?.evidence?.dispatch_id;
  if (typeof fromEvidence === 'string' && fromEvidence.trim().length > 0) {
    return stripControlChars(fromEvidence.trim());
  }
  return INFRA_BLOCKED_DISPATCH_ID_FALLBACK;
}

/**
 * Top-level Stop-hook check for `infra_blocked` manual-test results.
 *
 * Hoisted ABOVE the runtime-validation-required gate (DEC-013) so non-rvr
 * specs that emit `infra_blocked` still block (REQ-003 — `infra_blocked` is
 * terminal regardless of `runtime_validation_required`).
 *
 * Fail-open guards (DEC-017 / NFR-2 / AC-8.3a): returns an empty array when
 *   - session is null/undefined
 *   - session.active_work is absent/null/non-object/array
 *   - session.active_work.manual_test_result is absent/null/non-object/array
 *   - manual_test_result.result !== 'infra_blocked'
 *
 * Mirrors the guard pattern at the top of validateRuntimeManualTestGate
 * (`session?.active_work?.manual_test_result` then shape check).
 *
 * Returns 0..2 reason strings to be APPENDED to runtimeManualTestBlockReasons
 * (DEC-002 — joins existing aggregation bucket; no new parallel array). When
 * the human-confirmation gate trips (counter >= 2), both reasons are emitted
 * in dispatch_id-stable order: terminal first, human-confirmation second.
 *
 * @param {object|null|undefined} session loaded session.json content
 * @returns {string[]} block-reason strings; empty array means no block emit
 */
function evaluateInfraBlockedTopLevel(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return [];
  }
  const activeWork = session.active_work;
  if (!activeWork || typeof activeWork !== 'object' || Array.isArray(activeWork)) {
    return [];
  }
  const result = activeWork.manual_test_result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return [];
  }
  if (result.result !== 'infra_blocked') {
    return [];
  }

  const narrative = formatInfraBlockedNarrative(result);
  const dispatchId = formatInfraBlockedDispatchId(result);
  const reasons = [
    `${INFRA_BLOCKED_TERMINAL_REASON_PREFIX}: ${narrative} [dispatch_id=${dispatchId}]. ` +
      `Operator must run 'node .claude/scripts/session-checkpoint.mjs clear-manual-test-result <sg-id>' to resume.`,
  ];

  // DEC-010 / AC-6.1: emit the human-confirmation block-reason when the
  // counter for this dispatch_id has reached 2 or more within the current
  // phase. The counter is read from the same session snapshot the writer
  // produced (counter-increment ordering per DEC-012 in opRecordManualTestResult).
  const counterMap = activeWork.dispatch_infra_blocked_count;
  if (counterMap && typeof counterMap === 'object' && !Array.isArray(counterMap)) {
    const count = counterMap[dispatchId];
    if (Number.isInteger(count) && count >= INFRA_BLOCKED_HUMAN_CONFIRMATION_THRESHOLD) {
      reasons.push(
        `${INFRA_BLOCKED_HUMAN_CONFIRMATION_REASON_PREFIX}: dispatch_id=${dispatchId} count=${count}. ` +
          `Operator must explicitly acknowledge before honoring the halt.`
      );
    }
  }

  return reasons;
}

function toProjectRelativePath(claudeDir, absolutePath) {
  const projectRoot = resolve(join(claudeDir, '..'));
  return relative(projectRoot, absolutePath).split(sep).join('/');
}

function parseMarkdownFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    const parsed = YAML.parse(match[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function listRuntimeValidationSpecFiles(claudeDir, specGroupId) {
  const specFiles = [];
  const sgDir = join(claudeDir, 'specs', 'groups', specGroupId);
  const specPath = join(sgDir, 'spec.md');
  if (existsSync(specPath)) {
    specFiles.push(specPath);
  }

  return specFiles;
}

function inspectRuntimeValidationRequirement(claudeDir, specGroupId) {
  const requirement = {
    required: false,
    markers: [],
    errors: [],
  };

  if (!specGroupId || !/^sg-[a-z0-9-]+$/.test(specGroupId)) {
    return requirement;
  }

  for (const specFile of listRuntimeValidationSpecFiles(claudeDir, specGroupId)) {
    let frontmatter = null;
    try {
      frontmatter = parseMarkdownFrontmatter(readFileSync(specFile, 'utf8'));
    } catch {
      continue;
    }
    if (!frontmatter || frontmatter.runtime_validation_required === undefined) {
      continue;
    }

    const relPath = toProjectRelativePath(claudeDir, specFile);
    const markerValue = frontmatter.runtime_validation_required;
    if (typeof markerValue !== 'boolean') {
      requirement.required = true;
      requirement.errors.push(
        `${relPath}: runtime_validation_required must be boolean true/false`
      );
      continue;
    }
    if (markerValue !== true) {
      continue;
    }

    requirement.required = true;
    const surface = frontmatter.runtime_validation_surface;
    const rationale = frontmatter.runtime_validation_rationale;

    if (!VALID_RUNTIME_VALIDATION_SURFACES.includes(surface)) {
      requirement.errors.push(
        `${relPath}: runtime_validation_surface must be one of ${VALID_RUNTIME_VALIDATION_SURFACES.join(', ')}`
      );
    }
    if (typeof rationale !== 'string' || rationale.trim().length === 0) {
      requirement.errors.push(
        `${relPath}: runtime_validation_rationale is required when runtime_validation_required=true`
      );
    }

    requirement.markers.push({
      spec_file: relPath,
      surface,
      rationale,
    });
  }

  return requirement;
}

function resolveManualTestEvidencePath(claudeDir, specGroupId, evidencePath) {
  if (typeof evidencePath !== 'string' || evidencePath.trim().length === 0) {
    return { ok: false, reason: 'evidence_path is missing' };
  }

  const projectRoot = resolve(join(claudeDir, '..'));
  const specGroupDir = resolve(join(claudeDir, 'specs', 'groups', specGroupId));
  const evidenceDir = resolve(join(specGroupDir, 'evidence'));
  const rawPath = evidencePath.trim();

  let candidate;
  if (isAbsolute(rawPath)) {
    candidate = rawPath;
  } else if (rawPath === '.claude' || rawPath.startsWith('.claude/')) {
    candidate = join(projectRoot, rawPath);
  } else {
    candidate = join(specGroupDir, rawPath);
  }

  const resolved = resolve(candidate);
  const insideEvidenceDir =
    resolved === evidenceDir || resolved.startsWith(evidenceDir + sep);
  if (!insideEvidenceDir) {
    return {
      ok: false,
      reason: `evidence_path must be under .claude/specs/groups/${specGroupId}/evidence/`,
    };
  }

  return { ok: true, path: resolved };
}

function validateRuntimeManualTestGate(session, allTasks, claudeDir, specGroupId, currentPhase) {
  const reasons = [];
  const requirement = inspectRuntimeValidationRequirement(claudeDir, specGroupId);

  if (!requirement.required) {
    return { required: false, reasons };
  }

  if (!RUNTIME_MANUAL_TEST_PHASES.has(currentPhase)) {
    return { required: true, reasons };
  }

  for (const markerError of requirement.errors) {
    reasons.push(`Runtime validation marker invalid: ${markerError}`);
  }

  const hasManualTesterDispatch = allTasks.some((task) =>
    task &&
    task.subagent_type === 'manual-tester' &&
    task.spec_group_id === specGroupId
  );
  if (!hasManualTesterDispatch) {
    reasons.push(`Missing manual-tester dispatch record for ${specGroupId}.`);
  }

  const result = session.active_work?.manual_test_result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    reasons.push('Missing structured manual-test result at session.active_work.manual_test_result.');
    return { required: true, reasons };
  }

  if (result.spec_group_id !== specGroupId) {
    reasons.push(
      `Structured manual-test result is for ${result.spec_group_id || '<missing>'}, expected ${specGroupId}.`
    );
  }

  // sg-manual-tester-infra-blocked-20260508 / AS-3 / AC-1.x / AC-7.3:
  // four-value enum admits `infra_blocked`. Out-of-enum values continue to
  // fail-through the existing 'invalid result' path.
  if (!['pass', 'fail', 'blocked', 'infra_blocked'].includes(result.result)) {
    reasons.push(`Structured manual-test result has invalid result '${result.result}'.`);
    return { required: true, reasons };
  }

  // sg-manual-tester-infra-blocked-20260508 / AS-3 / AC-8.5 / DEC-004.
  // Intercept ordering: the `infra_blocked` branch fires BEFORE the generic
  // non-pass branch so the operator sees the structured narrative + dispatch_id
  // rather than the generic 'expected pass' string. The hoisted top-level
  // branch (above validateRuntimeManualTestGate) carries the actual block
  // emission for non-rvr specs; this in-function branch handles the rvr-spec
  // case where `validateRuntimeManualTestGate` is reached with an
  // `infra_blocked` result. The reason content matches the hoisted branch's
  // structured narrative (AC-8.2: contains both narrative substring and
  // dispatch_id substring).
  if (result.result === 'infra_blocked') {
    const narrativeText = formatInfraBlockedNarrative(result);
    const dispatchText = formatInfraBlockedDispatchId(result);
    reasons.push(
      `Manual-test infra_blocked: ${narrativeText} [dispatch_id=${dispatchText}]. ` +
        `Operator must run 'node .claude/scripts/session-checkpoint.mjs clear-manual-test-result <sg-id>' to resume.`
    );
    return { required: true, reasons };
  }

  if (result.result !== 'pass') {
    reasons.push(`Structured manual-test result is '${result.result}', expected 'pass'.`);
    return { required: true, reasons };
  }

  if (!Number.isInteger(result.scenario_count) || result.scenario_count <= 0) {
    reasons.push('Passing manual-test result requires scenario_count > 0.');
  }
  if (!Number.isInteger(result.pass_count) || result.pass_count <= 0) {
    reasons.push('Passing manual-test result requires pass_count > 0.');
  }
  if (result.fail_count !== 0) {
    reasons.push('Passing manual-test result requires fail_count === 0.');
  }

  const evidence = resolveManualTestEvidencePath(
    claudeDir,
    specGroupId,
    result.evidence_path,
  );
  if (!evidence.ok) {
    reasons.push(evidence.reason);
  } else if (!existsSync(evidence.path)) {
    reasons.push(`Manual-test evidence_path does not exist: ${result.evidence_path}.`);
  }

  return { required: true, reasons };
}

/**
 * Detect whether the session edited any file in the trust-bearing allowlist
 * during the current work session. Scans session.history[] for events
 * whose details reference a file path matching the allowlist.
 *
 * Returns the first matching path, or null if none. Implementation is
 * conservative: only matches exact relative-path suffixes on a path-boundary
 * character, so a file path embedded in a comment won't match without its
 * full "scripts/..." prefix.
 *
 * @param {object} session - The session object (from loadSession).
 * @param {string} claudeDir - Resolved .claude/ directory (unused now; kept
 *   for future realpath-based match).
 * @returns {string|null} Matching allowlist path, or null.
 */
function detectTrustBearingEdit(session, claudeDir) {
  void claudeDir;
  const history = session?.history || [];
  if (!Array.isArray(history)) return null;
  const normalizedAllowlist = TRUST_BEARING_ALLOWLIST.map((p) =>
    p.replace(/^\.claude\//, '')
  );
  for (const entry of history) {
    const fields = [];
    if (entry.details) {
      for (const v of Object.values(entry.details)) {
        if (typeof v === 'string') fields.push(v);
      }
    }
    for (const s of fields) {
      for (const allowed of normalizedAllowlist) {
        const idx = s.indexOf(allowed);
        if (idx === -1) continue;
        const isBoundary = idx === 0 || s[idx - 1] === '/' || s[idx - 1] === '\\';
        if (!isBoundary) continue;
        const after = s[idx + allowed.length];
        if (
          after === undefined ||
          after === ' ' ||
          after === ',' ||
          after === '"' ||
          after === ')'
        ) {
          return allowed;
        }
      }
    }
  }
  return null;
}

/**
 * Emit the `UNLOCK_USED_NO_TESTS` advisory heartbeat (as-008 / AC-005.9).
 *
 * Runs the pure-detection helper; if it classifies the session as misuse,
 * writes a stderr line AND appends a `test_writer_unlock_misuse` audit entry
 * via the cross-cutting appender. Non-blocking: any exception inside this
 * function is swallowed and emitted to stderr as a structured warning so
 * the Stop hook's main flow never crashes on a misuse-signal emission
 * failure.
 *
 * @param {object} session - Loaded session.json object.
 * @param {string} claudeDir - Resolved `.claude/` directory.
 * @returns {Promise<void>}
 */
async function emitUnlockMisuseHeartbeat(session, claudeDir) {
  try {
    // projectRoot for git diff cwd — repo root is the parent of `.claude/`.
    const projectRoot = join(claudeDir, '..');
    const result = detectUnlockMisuse(session, projectRoot);
    if (!result.fire) return;

    // AC8.1: stderr advisory line with stable prefix for operator grep.
    process.stderr.write(
      formatMisuseStderrLine({
        specGroupId: result.specGroupId,
        dispatchId: result.dispatchId,
        unlockedUntil: result.unlockedUntil,
      }) + '\n',
    );

    // AC8.1: audit-log entry via as-007 helper
    // (pipeline-efficiency-audit-log.mjs appendAuditEntry).
    try {
      const { appendAuditEntry } = await import(
        './pipeline-efficiency-audit-log.mjs'
      );
      const { event_subtype, payload } = buildMisuseAuditPayload({
        specGroupId: result.specGroupId,
        dispatchId: result.dispatchId,
        unlockedUntil: result.unlockedUntil,
        actorFallback: process.env.USER || 'agent',
      });
      appendAuditEntry(MISUSE_EVENT_CLASS, event_subtype, payload);
    } catch (auditErr) {
      // AC8.4: non-blocking. A chain-append failure here must not prevent
      // session completion. Emit a structured stderr warning so operators
      // can reconcile the missed audit entry.
      process.stderr.write(
        `[workflow-stop-enforcement] WARNING: ${MISUSE_ADVISORY_CODE} ` +
          `audit-append failed: ${auditErr && auditErr.message} ` +
          `(spec_group_id=${result.specGroupId})\n`,
      );
    }
  } catch (err) {
    // Defensive: any unexpected error in the detection path is non-fatal.
    process.stderr.write(
      `[workflow-stop-enforcement] WARNING: unlock-misuse heartbeat ` +
        `evaluation failed: ${err && err.message} -- fail-open\n`,
    );
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
    //
    // Dual-path lookup (sg-pipeline-efficiency-ws3 / as-007 AC7.2 fixture
    // alignment): mirror of workflow-gate-enforcement.mjs Step 3. When
    // CLAUDE_PROJECT_DIR is mutated to a decoy path that either lacks a
    // session or carries a pin-less session, the cwd-rooted session
    // takes precedence when it carries a `project_dir_pin`. cwd is the
    // trust anchor set by the Claude Code host and cannot be spoofed by
    // env mutation.
    const sessionPath = join(claudeDir, 'context', 'session.json');
    const envSession = loadSession(sessionPath);
    // worktree-canon dual-path: process.cwd() is the trust-anchor (cannot
    // be spoofed by CLAUDE_PROJECT_DIR mutation). The pin-comparison
    // downstream (enforceEnvParity) does the actual canon enforcement.
    const cwdSessionPath = join(process.cwd(), '.claude', 'context', 'session.json');
    const cwdSession = cwdSessionPath !== sessionPath ? loadSession(cwdSessionPath) : null;

    function hasPin(s) {
      return !!(s && s.active_work && s.active_work.project_dir_pin);
    }
    let session;
    if (hasPin(cwdSession)) {
      session = cwdSession;
    } else if (hasPin(envSession)) {
      session = envSession;
    } else {
      session = envSession || cwdSession;
    }

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
    // sg-enforcement-layer-gaps Task 27 / REQ-M2-003 / AC-8.5, AC-8.6:
    // Distinguish positive-assertion bypass from fail-open-on-missing.
    if (!session.active_work) {
      process.stderr.write(
        '[workflow-stop-enforcement] event=no_active_work assertion_state=missing exit=0_fail_open\n'
      );
      process.exit(0); // No active work -- fail-open
    }

    // Step 4a: Worktree-canon env-parity check (sg-pipeline-efficiency-ws3
    // / as-007 / REQ-007 / AC7.1, AC7.2).
    //
    // Invariant: if `session.active_work.project_dir_pin` is set, the current
    // `CLAUDE_PROJECT_DIR` MUST canonicalize to the same path. On mismatch →
    // exit 2 with structured `WORKTREE_PATH_VIOLATION` stderr + audit entry.
    // AC7.2: when pin matches env → existing logic runs normally.
    //
    // Legacy-session guard (spec as-007 Task 4): pin absent → no-op.
    //
    // Dynamic import of as-005 worktree-canon library mirrors the
    // `appendAuditEntry` lazy-import pattern at line 239. If the module is
    // absent (as-005 not yet landed) → fall through; stop-hook enforcement
    // continues. Once as-005 lands, env-parity activates automatically.
    //
    // Rationale for exit 2 (not stdout-JSON block): the spec contract
    // (as-007 AC7.1) specifies `exit 2 with WORKTREE_PATH_VIOLATION` for
    // consistency with the PreToolUse gate hook's violation path. The env-
    // mutation scenario is a security-critical hard block, not a normal
    // completion-gate block; exit 2 ensures the termination is visible to
    // operators regardless of how the host process handles stdout JSON.
    const projectDirPin = session.active_work.project_dir_pin;
    if (projectDirPin && typeof projectDirPin === 'string' && projectDirPin.length > 0) {
      try {
        const canonMod = await import('./lib/worktree-canon.mjs');
        canonMod.enforceEnvParity(projectDirPin);
      } catch (canonErr) {
        const isMissingModule =
          canonErr &&
          (canonErr.code === 'ERR_MODULE_NOT_FOUND' ||
            /Cannot find module/.test(String(canonErr.message || '')));
        if (isMissingModule) {
          process.stderr.write(
            '[workflow-stop-enforcement] worktree-canon module absent -- env-parity check skipped\n'
          );
        } else {
          const reason = canonErr.reason || 'unknown';
          // as-021 canon-lock: worktree-canon enforceEnvParity already
          // rejected; the process.env read is strictly for the error message.
          const attemptedPath =
            canonErr.attempted_path || process.env.CLAUDE_PROJECT_DIR || '<unset>';
          const code = canonErr.code || 'WORKTREE_PATH_VIOLATION';

          // Append audit entry (NFR-5 item e). Non-blocking on failure.
          //
          // as-009 refactor (REQ-007 Task 2): route through the shared
          // `appendWorktreeAuditEntry` shim (which delegates to the
          // `logWorktreeViolation` helper). event_subtype becomes the
          // violation reason; the hook label lands in payload.consumer.
          try {
            const { appendWorktreeAuditEntry } = await import(
              './lib/worktree-enforcement.mjs'
            );
            // projectRoot anchor (as-007 AC7.2 fixture alignment): route the
            // audit write to the PINNED project's `.claude/audit/` rather
            // than CLAUDE_PROJECT_DIR's (which may be spoofed).
            const result = await appendWorktreeAuditEntry(reason, {
              attempted_path: attemptedPath,
              pinned_root: projectDirPin,
              consumer: 'workflow-stop-enforcement',
              hook: 'workflow-stop-enforcement',
              session_id: sessionId,
            }, { projectRoot: projectDirPin });
            if (!result || result.audited !== true) {
              process.stderr.write(
                `[workflow-stop-enforcement] WARNING: audit-append failed for WORKTREE_PATH_VIOLATION: ${result && result.error}\n`
              );
            }
          } catch (auditErr) {
            process.stderr.write(
              `[workflow-stop-enforcement] WARNING: audit-append failed for WORKTREE_PATH_VIOLATION: ${auditErr && auditErr.message}\n`
            );
          }

          process.stderr.write('\n');
          process.stderr.write('========================================\n');
          process.stderr.write('BLOCKED: WORKTREE_PATH_VIOLATION\n');
          process.stderr.write('========================================\n');
          process.stderr.write('\n');
          process.stderr.write(`code:           ${code}\n`);
          process.stderr.write(`reason:         ${reason}\n`);
          process.stderr.write(`attempted_path: ${attemptedPath}\n`);
          process.stderr.write(`pinned_root:    ${projectDirPin}\n`);
          process.stderr.write('\n');
          process.stderr.write(
            'CLAUDE_PROJECT_DIR does not canonicalize to session.active_work.project_dir_pin.\n'
          );
          process.stderr.write(
            'Resolve by restoring the pinned CLAUDE_PROJECT_DIR, or re-pin via:\n'
          );
          process.stderr.write(
            '  node .claude/scripts/session-checkpoint.mjs rotate-worktree <new-root>\n'
          );
          process.stderr.write('\n');
          process.stderr.write('========================================\n');
          process.stderr.write('\n');
          process.exit(2);
        }
      }
    }

    // Step 4b: Unlock-misuse heartbeat. Fires BEFORE workflow/exempt/phase
    // gating so the heartbeat emits regardless of where the Stop hook's
    // subsequent path lands (clean exit, obligation block, exempt bypass).
    // Non-blocking: always falls through to normal flow.
    await emitUnlockMisuseHeartbeat(session, claudeDir);

    // Step 5: Get workflow type
    const workflow = getWorkflowTypeStrict(session);
    if (!workflow) {
      process.stderr.write(
        '[workflow-stop-enforcement] event=invalid_workflow assertion_state=invalid exit=0_fail_open\n'
      );
      process.exit(0); // No workflow set -- fail-open
    }

    let trustBearingEdit = null;
    let trustBearingEditDetectionFailed = false;
    let trustBearingEditDetectionError = null;
    try {
      trustBearingEdit = detectTrustBearingEdit(session, claudeDir);
    } catch (err) {
      trustBearingEditDetectionFailed = true;
      trustBearingEditDetectionError = err;
      process.stderr.write(
        `[workflow-stop-enforcement] WARNING: trust-bearing allowlist check failed (${err.message}); using trust-bearing stop requirements\n`
      );
    }

    // Step 6: Check exempt workflow (AC-4.7, AC-8.5, AC-8.6)
    // sg-enforcement-layer-gaps Task 27 / REQ-M2-006 / AC-11.1, AC-11.2, AC-11.3:
    // Trust-bearing allowlist check BEFORE exempt-workflow bypass. If the
    // session edited any enforcement-layer file during a vibe-mode session,
    // FAIL CLOSED (do not exit exempt). On allowlist-check crash → fail closed.
    if (isExemptWorkflow(workflow)) {
      if (trustBearingEditDetectionFailed) {
        // AC-11.3 — allowlist-check crash fails closed (NFR-13 uncommon but
        // critical).
        process.stdout.write(
          JSON.stringify({
            decision: 'block',
            reason:
              `Stop hook: allowlist-check crashed during vibe-mode exempt evaluation (${trustBearingEditDetectionError?.message}). Failing closed.`,
          }) + '\n'
        );
        process.exit(0);
      }
      if (trustBearingEdit) {
        // AC-11.2: fail closed — do NOT exit exempt. Emit blocking JSON.
        process.stdout.write(
          JSON.stringify({
            decision: 'block',
            reason:
              `Stop hook: vibe-mode session edited trust-bearing file '${trustBearingEdit}'. ` +
              `Exempt-workflow bypass denied per AC-11.1/11.2. ` +
              `Review session.history[] to verify legitimacy or run complete-work to promote the workflow.`,
          }) + '\n'
        );
        process.exit(0);
      }

      process.stderr.write(
        `[workflow-stop-enforcement] event=positive_assertion_bypass workflow=${workflow} assertion_state=positive allowlist_clean=true exit=0_exempt\n`
      );
      process.exit(0); // Exempt workflow + no trust-bearing edits -- no enforcement
    }

    // Step 7: Phase-aware mandatory dispatch check (REQ-001 through REQ-008)
    // Determine which dispatches are required based on current session phase.
    const currentPhase = session.active_work.current_phase;

    if (!currentPhase || typeof currentPhase !== 'string') {
      // REQ-008: Missing or non-string phase -- fail-open
      process.exit(0);
    }

    const requiredDispatches = getStopPhaseRequirements(
      currentPhase,
      trustBearingEdit || trustBearingEditDetectionFailed
        ? 'trust-bearing'
        : session,
    );

    const allTasks = getAllTasks(session);
    const specGroupId = session.active_work?.spec_group_id;
    const missingDispatches = [];

    for (const requiredType of requiredDispatches) {
      // AC-4.11: Any status satisfies (presence check only)
      const found = allTasks.some(t => t.subagent_type === requiredType);
      if (!found) {
        missingDispatches.push(requiredType);
      }
    }

    // E2E opt-out recognition.
    // If e2e-test-writer is missing, check spec frontmatter for opt-out.
    // Data-flow: session.json -> spec_group_id -> convention-based spec path -> frontmatter.
    const e2eIdx = missingDispatches.indexOf('e2e-test-writer');
    if (e2eIdx !== -1) {
      const sgId = specGroupId;
      let e2eOptedOut = false;

      if (sgId && /^sg-[a-z0-9-]+$/.test(sgId)) {
        try {
          const sgDir = join(claudeDir, 'specs', 'groups', sgId);

          const specFiles = [join(sgDir, 'spec.md')];

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

    // Step 7.5r: Runtime manual-test requirement.
    //
    // Specs may explicitly declare runtime_validation_required: true when
    // plugin/MCP/connector/dynamic-tool behavior needs live boot validation.
    // This is intentionally conditional; unmarked specs keep the existing
    // advisory /manual-test behavior.
    let runtimeManualTestBlockReasons = [];
    let runtimeManualTestOverridden = false;

    // sg-manual-tester-infra-blocked-20260508 / AS-3 / DEC-013 / DEC-017.
    // Hoisted top-level `infra_blocked` branch. Evaluated BEFORE
    // validateRuntimeManualTestGate so non-rvr specs that emit `infra_blocked`
    // still block (REQ-003 — `infra_blocked` is terminal regardless of
    // runtime_validation_required). Reasons append to
    // runtimeManualTestBlockReasons (DEC-002 — joins the existing aggregation
    // bucket; no new parallel array).
    //
    // Fail-open guards (DEC-017 / NFR-2 / AC-8.3a) are inside
    // evaluateInfraBlockedTopLevel: missing/null/non-object/array session-state
    // returns an empty array and yields no block emit.
    //
    // When `infra_blocked` is present, we short-circuit the
    // validateRuntimeManualTestGate call: the hoisted branch is the canonical
    // emitter for `infra_blocked`. The legacy gate handles `pass | fail | blocked`
    // only.
    let infraBlockedReasons = [];
    try {
      infraBlockedReasons = evaluateInfraBlockedTopLevel(session);
    } catch (err) {
      process.stderr.write(
        `[workflow-enforcement] WARNING: infra_blocked top-level check error: ${err.message} -- fail-open\n`
      );
      infraBlockedReasons = [];
    }

    if (infraBlockedReasons.length > 0) {
      runtimeManualTestBlockReasons = infraBlockedReasons;
    } else {
      try {
        const runtimeManualTestResult = validateRuntimeManualTestGate(
          session,
          allTasks,
          claudeDir,
          specGroupId,
          currentPhase,
        );
        runtimeManualTestBlockReasons = runtimeManualTestResult.reasons;
      } catch (err) {
        process.stderr.write(
          `[workflow-enforcement] WARNING: runtime-manual-test check error: ${err.message} -- fail-open\n`
        );
        runtimeManualTestBlockReasons = [];
      }
    }

    if (runtimeManualTestBlockReasons.length > 0) {
      const runtimeOverridePath = join(coordinationDir, OVERRIDE_FILENAME);
      const overrides = loadOverrides(runtimeOverridePath);
      if (overrides) {
        const bySpecGroup = specGroupId
          ? findMatchingOverride(overrides, OVERRIDE_GATE_NAMES.runtime_manual_test, specGroupId)
          : null;
        const bySession = findMatchingOverride(
          overrides,
          OVERRIDE_GATE_NAMES.runtime_manual_test,
          sessionId,
        );
        runtimeManualTestOverridden = !!(bySpecGroup || bySession);
      }

      if (!runtimeManualTestOverridden && existsSync(runtimeOverridePath)) {
        try {
          const rawOverride = JSON.parse(readFileSync(runtimeOverridePath, 'utf8'));
          const flat = rawOverride?.[OVERRIDE_GATE_NAMES.runtime_manual_test];
          if (flat && typeof flat === 'object' && flat.rationale && flat.timestamp) {
            runtimeManualTestOverridden = true;
          }
        } catch {
          // Fail closed on runtime manual-test override parse failures.
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
    // Unrecognized phase strings also skip as fail-open.
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

    // =========================================================================
    // Step 7.6b: completion-invariant checks
    // Guard via shouldRunChecks: only fire when the session is spec-coupled,
    // at phase 'complete', and not exempt. Structural errors (missing spec
    // group dir, missing manifest) fail-open; data-validity errors
    // (missing/wrong-type clean_pass_count, etc.) fail-closed.
    //
    // Block reasons collected into the checkBlockReasons[] array and merged
    // into the canonical reasonParts[] in Step 9. Enforcement level respected
    // per CHECK_ENFORCEMENT_POLICY (convergence/sanity/artifact always block;
    // challenger-stages and phase-DAG respect warn-only).
    //
    // Per-failure rendering delegates to the shared format helpers in
    // lib/stop-hook-checks.mjs (CR-M2). The `"  - "` prefix argument produces
    // the indented-dash multi-line block shape used here; the CLI `verify`
    // subcommand reuses the same helpers without a prefix for inline rendering.
    // =========================================================================
    const HOOK_LINE_PREFIX = '  - ';
    const checkBlockReasons = [];

    /**
     * Dispatch a failure message into either the block or warning channel
     * based on policy + enforcement level. Centralizes the warn-only branch
     * so callers below stay short. stderr WARNING line kept identical to
     * preserve existing observable output.
     */
    const routeRespectedFailure = (checkName, msg) => {
      if (CHECK_ENFORCEMENT_POLICY[checkName] === 'respect' && enforcementLevel === 'warn-only') {
        process.stderr.write(`[workflow-enforcement] WARNING: ${msg}\n`);
      } else {
        checkBlockReasons.push(msg);
      }
    };

    if (shouldRunChecks(session)) {
      // Check 1: Convergence depth — policy 'always'.
      //
      // as-008 / REQ-012 / AC8.1: re-score each failure using the per-gate
      // `required_clean_passes` read from `session.active_work.threshold_snapshot`.
      // The lib-level `checkConvergenceDepth()` compares against the hardcoded
      // `REQUIRED_CLEAN_PASSES` (grep-lock-locked by as-011 / as-014); the hook
      // layer augments that verdict with snapshot-aware thresholds without
      // touching the grep-locked constant.
      //
      // Behavior preservation (AC8.2):
      //   - Snapshot absent OR gate-threshold read falls through to fallback →
      //     failure list unchanged from lib's verdict.
      //   - Snapshot present → drop failures whose `observed >= snapshot_threshold`;
      //     keep/raise failures where observed falls below the snapshot value.
      //   - Gates where the snapshot threshold is higher than the hardcoded 2
      //     are re-evaluated against ALL valid gates, not just lib-reported
      //     failures (otherwise a raised threshold would be silently ignored).
      try {
        const depthResult = checkConvergenceDepth(session, sharedManifest);
        const snapshotScopedFailures = [];
        const seenGates = new Set();
        const convergenceObj = session?.convergence || {};

        // Re-score lib-reported failures against snapshot thresholds first
        // (drop or retain based on observed vs. snapshot value).
        for (const f of depthResult.failures) {
          seenGates.add(f.gate);
          const snapshotThreshold = readThresholdFromSnapshot(
            session,
            f.gate,
            f.required,
          );
          if (f.observed < snapshotThreshold) {
            snapshotScopedFailures.push({
              ...f,
              required: snapshotThreshold,
            });
          }
          // else: observed >= snapshot threshold — drop (snapshot relaxed).
        }

        // Re-evaluate gates that lib judged PASSING (absent from failures) but
        // that the snapshot requires more passes for (threshold raised).
        // Iterate the same gate set lib uses: session.convergence keys that
        // appear as recognized gates. Use existing records only — the lib
        // already enumerates VALID_CONVERGENCE_GATES, so any unreported gate
        // implies observed >= hardcoded fallback. If the snapshot raises the
        // bar above that fallback, surface a new failure.
        for (const gate of Object.keys(convergenceObj)) {
          if (seenGates.has(gate)) continue;
          const gateRecord = convergenceObj[gate];
          const observed =
            typeof gateRecord?.clean_pass_count === 'number' &&
            Number.isFinite(gateRecord.clean_pass_count)
              ? gateRecord.clean_pass_count
              : 0;
          // fallback=2 mirrors the lib's hardcoded comparand; no inline literal
          // here is an enforcement-threshold check — it's the graceful-degrade
          // floor per AC8.3 when the snapshot is absent.
          const snapshotThreshold = readThresholdFromSnapshot(
            session,
            gate,
            2,
          );
          if (observed < snapshotThreshold) {
            snapshotScopedFailures.push({
              gate,
              observed,
              required: snapshotThreshold,
            });
          }
        }

        if (snapshotScopedFailures.length > 0) {
          const lines = snapshotScopedFailures
            .map(f => formatConvergenceDepthFailure(f, HOOK_LINE_PREFIX))
            .join('\n');
          checkBlockReasons.push(`Convergence depth below threshold:\n${lines}`);
        }
      } catch (err) {
        process.stderr.write(`[workflow-enforcement] WARNING: convergence-depth check error: ${err.message} -- fail-open\n`);
      }

      // Check 2: Challenger stage coverage — policy 'respect'.
      try {
        const stageResult = checkChallengerStages(session, workflow);
        if (!stageResult.passed) {
          const lines = stageResult.failures
            .map(f => formatChallengerStagesFailure(f, HOOK_LINE_PREFIX))
            .join('\n');
          routeRespectedFailure(
            'challengerStages',
            `Missing challenger stages for ${workflow}:\n${lines}`,
          );
        }
      } catch (err) {
        process.stderr.write(`[workflow-enforcement] WARNING: challenger-stages check error: ${err.message} -- fail-open\n`);
      }

      // Check 3: Phase DAG predecessor completeness — policy 'respect'.
      try {
        const dagResult = checkPhaseDagPredecessors(session, workflow);
        if (!dagResult.passed) {
          const hasHistoryMissing = dagResult.failures.some(f => f.finding_type === 'history_missing');
          let msg;
          if (hasHistoryMissing) {
            // Pre-render without prefix: this is a single-finding status line
            // rather than a multi-reason block.
            msg = formatPhaseDagFailure(dagResult.failures[0]);
          } else {
            const lines = dagResult.failures
              .filter(f => f.finding_type === 'phase_not_visited')
              .map(f => formatPhaseDagFailure(f, HOOK_LINE_PREFIX))
              .join('\n');
            msg = `Missing phase-DAG predecessors:\n${lines}`;
          }
          routeRespectedFailure('phaseDag', msg);
        }
      } catch (err) {
        process.stderr.write(`[workflow-enforcement] WARNING: phase-DAG check error: ${err.message} -- fail-open\n`);
      }

      // Check 4: Artifact inventory — policy 'always' with structural fail-open.
      try {
        // Caller owns spec_group_id format validation (SEC-001 parity) — already
        // validated in Step 7.5 (specGroupId matched /^sg-[a-z0-9-]+$/ before
        // sharedManifest was loaded). Construct absolute dir path only.
        const specGroupDir = join(claudeDir, 'specs', 'groups', specGroupId);
        const artifactResult = checkArtifactInventory(specGroupDir, workflow);
        if (!artifactResult.passed) {
          // Fail-open on structural absence of the spec group directory
          // Emit stderr warning, do not block.
          const structural = artifactResult.failures.some(f => f.reason === 'spec_group_missing');
          if (structural) {
            process.stderr.write(`[workflow-enforcement] WARNING: spec group directory missing: ${specGroupDir} -- fail-open\n`);
          } else {
            const lines = artifactResult.failures
              .map(f => formatArtifactInventoryFailure(f, specGroupDir, HOOK_LINE_PREFIX))
              .join('\n');
            checkBlockReasons.push(`Missing required artifacts:\n${lines}`);
          }
        }
      } catch (err) {
        process.stderr.write(`[workflow-enforcement] WARNING: artifact-inventory check error: ${err.message} -- fail-open\n`);
      }

      // Check 5: Convergence-field sanity — policy 'always'.
      try {
        if (sharedManifest) {
          const sanityResult = checkConvergenceFieldSanity(session, sharedManifest);
          if (!sanityResult.passed) {
            const lines = sanityResult.failures
              .map(f => formatConvergenceSanityFailure(f, HOOK_LINE_PREFIX))
              .join('\n');
            checkBlockReasons.push(`Convergence-field sanity (manifest/session disagreement):\n${lines}`);
          }
        }
        // No manifest: check skipped silently as fail-open.
      } catch (err) {
        process.stderr.write(`[workflow-enforcement] WARNING: convergence-field-sanity check error: ${err.message} -- fail-open\n`);
      }
    }

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

    // Step 7.8: Deployment verification gate
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

    // Step 7.9: Pre-merge-verify gate
    // sg-pre-merge-verify-20260508 / AS-7 / AC-6.1..AC-6.6 / NFR-8.
    // Per DEC-008: NEW try/catch boundary parallel to the existing
    // deployment-verify block above. Each block has its own self-contained
    // try/catch boundary; structural errors in one block do NOT affect the
    // other. Composition: completionAllowed iff !deploymentBlocked && !preMergeBlocked.
    let preMergeBlocked = false;
    let preMergeBlockReason = '';

    try {
      const pmv = session.pre_merge_verify;

      if (pmv !== undefined && pmv !== null) {
        // AC-6.3: validate pre_merge_verify is an object (fail-open on non-object).
        if (typeof pmv !== 'object' || Array.isArray(pmv)) {
          process.stderr.write(
            `[workflow-enforcement] WARNING: Malformed pre_merge_verify object (type: ${typeof pmv}) -- fail-open\n`
          );
        } else {
          const status = pmv.status;
          const reason = pmv.reason;
          // AC-6.1..AC-6.3 decision rule:
          //   status === 'failed'   -> preMergeBlocked = true
          //   status ∈ {passed,skipped} -> preMergeBlocked = false
          //   missing or non-string status -> fail-open (preMergeBlocked = false)
          if (typeof status !== 'string') {
            process.stderr.write(
              `[workflow-enforcement] WARNING: pre_merge_verify.status is not string (${typeof status}) -- fail-open\n`
            );
          } else if (status === 'failed') {
            // sec-pmv-001 (Stop-hook ignores enforcement-disabled sentinel):
            // The pre-merge verifier runner honors the operator
            // pre-merge-verify-enforcement-disabled sentinel (NFR-21 escape
            // hatch), but the Stop-hook computed preMergeBlocked from
            // session.pre_merge_verify.status === 'failed' regardless of the
            // sentinel. That made the operator-flag advisory only inside the
            // gate run itself — once a 'failed' result was persisted, the
            // Stop-hook would still block completion. Re-read the sentinel
            // here so the operator override genuinely makes the gate
            // advisory-only (block decision composed AFTER the override
            // check). Sentinel filename matches PRE_MERGE_FLAG_RELPATH at
            // .claude/scripts/lib/pre-merge-verify.mjs:90.
            const preMergeFlagPath = join(coordinationDir, 'pre-merge-verify-enforcement-disabled');
            if (existsSync(preMergeFlagPath)) {
              process.stderr.write(
                '[workflow-enforcement] WARNING: pre-merge-verify-enforcement-disabled sentinel present -- gate is advisory-only (operator override per NFR-21)\n'
              );
              // Operator override: do NOT block completion despite a failed
              // pre-merge-verify result. The audit chain still retains the
              // failed entry; this only relaxes Stop-hook composition.
              preMergeBlocked = false;
            } else {
              preMergeBlocked = true;
              const safeReason = typeof reason === 'string' && reason.length > 0
                ? stripControlChars(reason)
                : '<missing reason>';
              // Surface narrative + dispatch_id when present; SEC: only sanitized
              // safe-message-only output here per Security Considerations §
              // Error sanitization (full evidence remains in the audit chain).
              const dispatchId = typeof pmv.dispatch_id === 'string' && pmv.dispatch_id.length > 0
                ? stripControlChars(pmv.dispatch_id)
                : null;
              preMergeBlockReason =
                `Pre-merge-verify gate failed: reason=${safeReason}` +
                (dispatchId ? ` dispatch=${dispatchId}` : '') +
                '. See audit chain for evidence narrative.';

              // ≥2-emission Stop-hook block-reason (AC-13.3 / NFR-14):
              // if dispatch_infra_blocked_count[<dispatch_id>] >= 2, surface
              // the human-confirmation block-reason in addition (parallel to
              // Item A's `infra_blocked_human_confirmation_required`).
              const counterMap =
                session.active_work && typeof session.active_work === 'object'
                  ? session.active_work.dispatch_infra_blocked_count
                  : null;
              if (
                dispatchId
                && counterMap
                && typeof counterMap === 'object'
                && !Array.isArray(counterMap)
                && Number.isInteger(counterMap[dispatchId])
                && counterMap[dispatchId] >= INFRA_BLOCKED_HUMAN_CONFIRMATION_THRESHOLD
              ) {
                preMergeBlockReason +=
                  `\nBlock-reason: pre_merge_verify_human_confirmation_required ` +
                  `(dispatch_id=${dispatchId} infra_blocked_count=${counterMap[dispatchId]}).`;
              }
            }
          }
          // status === 'passed' or 'skipped': preMergeBlocked stays false.
          // Unknown status string values: fail-open (preMergeBlocked stays false).
        }
      }
      // pre_merge_verify field absent -- gate has not run, do not block.
    } catch (err) {
      // AC-6.3: Fail-open on any structural error. Independent of the
      // deployment-verify block's try/catch (DEC-008).
      process.stderr.write(
        `[workflow-enforcement] WARNING: Pre-merge-verify gate structural error: ${err.message} -- fail-open\n`
      );
    }

    const hasRuntimeManualTestIssues =
      runtimeManualTestBlockReasons.length > 0 && !runtimeManualTestOverridden;

    // If no dispatch violations, no obligation violations, no completion-invariant blocks,
    // no deployment block, and no pre-merge-verify block, allow completion.
    // sg-pre-merge-verify-20260508 / AS-7 / NFR-8 truth-table conjunction.
    if (
      missingDispatches.length === 0 &&
      obligationViolations.length === 0 &&
      checkBlockReasons.length === 0 &&
      !hasRuntimeManualTestIssues &&
      !deploymentBlocked &&
      !preMergeBlocked
    ) {
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

    // If both dispatch and obligation issues are overridden/resolved, no completion-invariant
    // blocks, no deployment block, and no pre-merge-verify block, allow completion.
    if (
      dispatchOverridden &&
      obligationViolations.length === 0 &&
      checkBlockReasons.length === 0 &&
      !hasRuntimeManualTestIssues &&
      !deploymentBlocked &&
      !preMergeBlocked
    ) {
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

      // If no dispatch issues remain, no completion-invariant blocks, no deployment block,
      // and no pre-merge-verify block, allow completion.
      if (
        !hasDispatchIssues &&
        checkBlockReasons.length === 0 &&
        !hasRuntimeManualTestIssues &&
        !deploymentBlocked &&
        !preMergeBlocked
      ) {
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

    // Step 9.0b: completion-invariant check blocks
    // Append each accumulated block reason; each is an independent failure with
    // its own heading (convergence depth / challenger stages / etc.).
    for (const r of checkBlockReasons) {
      reasonParts.push(r);
    }

    if (hasRuntimeManualTestIssues) {
      const runtimeLines = runtimeManualTestBlockReasons
        .map((reason) => `  - ${reason}`)
        .join('\n');
      reasonParts.push(`Runtime manual-test required:\n${runtimeLines}`);
    }

    // Step 9.1: Deployment verification block
    if (deploymentBlocked) {
      reasonParts.push(deploymentBlockReason);
    }

    // Step 9.2: Pre-merge-verify gate block (sg-pre-merge-verify-20260508 / AS-7).
    // AC-6.6: when both deployment-verify and pre-merge-verify fail, both
    // reasons appear in the output independently — no precedence.
    if (preMergeBlocked) {
      reasonParts.push(preMergeBlockReason);
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
    if (hasRuntimeManualTestIssues) {
      remediationParts.push(
        `Run /manual-test ${specGroupId} and record a passing structured result with ` +
        `node .claude/scripts/session-checkpoint.mjs record-manual-test-result ${specGroupId} ` +
        `--result pass --scenario-count <N> --pass-count <N> --fail-count 0 ` +
        `--evidence-path .claude/specs/groups/${specGroupId}/evidence/report.md. ` +
        `To intentionally accept the risk, create a gate override for '${OVERRIDE_GATE_NAMES.runtime_manual_test}' with a rationale.`
      );
    }
    if (hasObligationIssues && enforcementLevel === 'graduated') {
      const convergenceFieldToGate = {
        investigation_converged: 'investigation',
        challenger_converged: 'challenger',
        unifier_passed: 'unifier',
        code_review_passed: 'code_review',
        security_review_passed: 'security_review',
        completion_verification_passed: 'completion_verifier',
      };
      const obligationInstructions = obligationViolations.map(v => {
        if (v.field.startsWith('convergence.')) {
          const convergenceField = v.field.replace('convergence.', '');
          const gate = convergenceFieldToGate[convergenceField] ||
            convergenceField.replace('_passed', '').replace('_converged', '');
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
    if (preMergeBlocked) {
      remediationParts.push(
        'Resolve pre-merge-verify gate failure:\n' +
        '  - Inspect audit chain: session.history filter event_type=pre_merge_verify_recorded\n' +
        '  - Re-run gate via /pre-merge-verify after fixing the underlying issue\n' +
        '  - For audit_chain_tamper_detected: node .claude/scripts/session-checkpoint.mjs repair-audit-chain ' + specGroupId + '\n' +
        '  - For quarantine state: node .claude/scripts/session-checkpoint.mjs clear-pre-merge-quarantine ' + specGroupId
      );
    }
    if (checkBlockReasons.length > 0) {
      remediationParts.push(
        'Resolve completion-invariant failures:\n' +
        '  - Verify locally: node .claude/scripts/session-checkpoint.mjs verify --spec-group ' + specGroupId + '\n' +
        '  - For convergence: run the convergence loop; then: node .claude/scripts/session-checkpoint.mjs update-convergence <gate>\n' +
        '  - For missing challenger stages: dispatch /challenge at the missing stage\n' +
        '  - For missing artifacts: run /investigate, /unify, or /docs as appropriate'
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
