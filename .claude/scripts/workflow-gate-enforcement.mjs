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
 *
 * Two-Store Convergence Model: this hook is an authoritative reader of
 *   session.json:.convergence.<gate>.clean_pass_count (session-scoped counter).
 *   manifest.json:.convergence.<gate>_converged is the durable store; the two
 *   stores are reconciled at start-work time ("manifest wins").
 *   See .claude/docs/WORKFLOW-ENFORCEMENT.md § Two-Store Convergence Model.
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ENFORCED_SUBAGENT_TYPES,
  OVERRIDE_GATE_NAMES,
  getWorkflowTypeStrict,
  isExemptWorkflow,
  getPrerequisites,
  werePrerequisitesMet,
  validateSubstages,
  getMissingRequiredSubstages,
} from './lib/workflow-dag.mjs';
import {
  readStdin,
  findClaudeDir,
  loadSession,
  loadOverrides,
  findMatchingOverride,
  parseStageFromPrompt,
} from './lib/hook-utils.mjs';
import { readThresholdFromSnapshot } from './lib/snapshot-threshold-reader.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Sentinel file that disables enforcement (kill switch). */
const KILL_SWITCH_FILENAME = 'gate-enforcement-disabled';

/** Override file for human-provided gate overrides. */
const OVERRIDE_FILENAME = 'gate-override.json';

/**
 * Timeout for the session-checkpoint.mjs subprocess that records
 * auto-detected challenger stages. cr-style-b712ef9c: hoisted from the inline
 * literal to document the reasoning: 2s is chosen because
 *   - session-lock.mjs retries once after 100ms before giving up (~200ms typical)
 *   - session-checkpoint.mjs write path is bounded by JSON serialization + fsync
 *     (<50ms under normal disk pressure)
 *   - 2s leaves ~1.8s of headroom for lock contention from parallel hook fires
 *     without visibly stalling the Claude Code dispatch turn.
 * Lengthening this risks user-perceived latency on the dispatch path;
 * shortening it risks flaky WARN messages under lock contention.
 */
const STAGE_AUTO_DETECT_TIMEOUT_MS = 2_000;

/**
 * Output a blocking message to stderr and exit with code 2.
 * Includes the blocked subagent type, missing prerequisites, guidance,
 * and the current session_id (AC-2.18).
 *
 * @param {string} subagentType - The blocked subagent type
 * @param {Array} missing - Array of { prerequisite, gate_name } objects
 * @param {string} sessionId - Current session ID from stdin
 * @param {string[]} [missingSubstages] - Optional array of missing required substages
 *   from validateSubstages() (ws-dag-substages / as-007c / AC7.1)
 */
function blockDispatch(subagentType, missing, sessionId, missingSubstages = []) {
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
        unifier: '/unify',
        completion_verifier: '/docs (then completion-verifier)',
      };
      const skill = skillMap[prereq.gate] || prereq.gate;
      process.stderr.write(
        `  - Run the convergence loop for '${prereq.gate}' until ${prereq.required_count} consecutive clean passes are recorded.\n` +
        `    Use: ${skill} (repeat until clean), then record with: node .claude/scripts/session-checkpoint.mjs update-convergence ${prereq.gate}\n`
      );
    }
  }

  // ws-dag-substages / as-007c / AC7.1: surface missing-substage reason in
  // the block stderr. Advisory only — this hook's primary enforcement is
  // the convergence-prerequisite check above. Substage obligation is
  // enforced at `transition-phase` (session-checkpoint.mjs).
  if (Array.isArray(missingSubstages) && missingSubstages.length > 0) {
    process.stderr.write('\n');
    process.stderr.write(`Missing required substages: ${missingSubstages.join(', ')}\n`);
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
// Evidence Integrity Verification (AC-4.1 through AC-4.5)
// =============================================================================

/** Minimum time between passes in milliseconds (10 seconds per AC-4.2). */
const MIN_PASS_INTERVAL_MS = 10_000;

/**
 * Verify the integrity of convergence evidence for a given gate.
 * This is advisory-only -- anomalies produce warnings but never block dispatch.
 *
 * Checks (AC-4.1):
 *   - pass_number values are sequential with no gaps
 *   - timestamps are sequential (non-decreasing)
 *   - evidence array length matches the highest pass_number
 *
 * Timing (AC-4.2):
 *   - Passes less than 10s apart flagged as suspicious
 *
 * Fallback (AC-4.3, AC-4.4):
 *   - On any error or anomaly, falls back to count-only verification
 *
 * @param {object} session - Session object from session.json
 * @param {string} gateName - Gate name to verify
 * @returns {{ warnings: string[] }} Array of advisory warnings (empty = clean)
 */
function verifyEvidenceIntegrity(session, gateName) {
  const warnings = [];

  try {
    const evidence = session.convergence_evidence?.[gateName]?.passes;

    if (!evidence || !Array.isArray(evidence) || evidence.length === 0) {
      // No evidence -- nothing to verify (legacy session or empty)
      return { warnings };
    }

    // Check sequential pass_number with no gaps
    for (let i = 0; i < evidence.length; i++) {
      const expectedNum = i + 1;
      if (evidence[i].pass_number !== expectedNum) {
        warnings.push(
          `[evidence-integrity] WARNING: ${gateName} pass_number gap: expected ${expectedNum}, got ${evidence[i].pass_number}`
        );
      }
    }

    // Check array length matches highest pass_number
    const highestPassNum = evidence[evidence.length - 1]?.pass_number;
    if (highestPassNum !== evidence.length) {
      warnings.push(
        `[evidence-integrity] WARNING: ${gateName} array length (${evidence.length}) does not match highest pass_number (${highestPassNum})`
      );
    }

    // Check sequential timestamps
    for (let i = 1; i < evidence.length; i++) {
      const prevTime = new Date(evidence[i - 1].timestamp).getTime();
      const currTime = new Date(evidence[i].timestamp).getTime();

      if (currTime < prevTime) {
        warnings.push(
          `[evidence-integrity] WARNING: ${gateName} non-sequential timestamps at passes ${i} and ${i + 1}`
        );
      }

      // AC-4.2: Check timing plausibility (10s minimum between passes)
      const intervalMs = currTime - prevTime;
      if (intervalMs < MIN_PASS_INTERVAL_MS) {
        warnings.push(
          `[evidence-integrity] WARNING: ${gateName} suspicious timing: passes ${i} and ${i + 1} are only ${Math.round(intervalMs / 1000)}s apart (minimum: 10s)`
        );
      }
    }
  } catch (err) {
    // AC-4.4: Script error -- fall back to trust-based count (fail-open)
    warnings.push(
      `[evidence-integrity] WARNING: Verification error for ${gateName}: ${err.message} -- falling back to count-only`
    );
  }

  return { warnings };
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

    // Stage auto-detect BEFORE gate prerequisite checks. When the prompt
    // contains a parseable `Stage: X` / `--stage X` pattern, invoke the
    // session-checkpoint CLI to record the stage + stage_source=auto_detected.
    // On lock contention or subprocess failure, log WARN and proceed without
    // blocking (fail-open per DEC-CHK-003).
    //
    // Only fires for challenger dispatches (other enforced subagents don't
    // use stages). A missing `subagent_type` still flows through to the
    // downstream checks that emit fail-open on invalid shapes.
    if (subagentType === 'challenger' && toolInput.prompt) {
      const parsed = parseStageFromPrompt(String(toolInput.prompt));
      if (parsed.reason === 'conflict') {
        process.stderr.write(
          `[workflow-gate-enforcement] WARN stage-auto-detect: conflicting stage patterns in prompt (matches=${(parsed.matches || []).join(',')}); skipping subprocess invocation.\n`,
        );
      } else if (parsed.stage) {
        // Find the session-checkpoint CLI path.
        const checkpointCli = join(claudeDir, 'scripts', 'session-checkpoint.mjs');
        if (existsSync(checkpointCli)) {
          // task_id: use a deterministic hash of sessionId + prompt-slice so
          // re-fires don't create duplicates.
          const taskId = `auto-${sessionId}-${Buffer.from(String(toolInput.prompt || '').slice(0, 64)).toString('base64url').slice(0, 12)}`;
          const descSnippet = String(toolInput.description || 'auto-detected-challenger').slice(0, 120);
          const spawnStart = Date.now();
          // Inherit env as-is; CLAUDE_PROJECT_DIR (when set) propagates via
          // `process.env` without an explicit re-read (the lint at as-012
          // AC1.2 forbids direct reads outside `lib/hook-utils.mjs`).
          const res = spawnSync(
            'node',
            [
              checkpointCli,
              'dispatch-subagent',
              taskId,
              'challenger',
              descSnippet,
              '--stage',
              parsed.stage,
              '--stage-source',
              'auto_detected',
            ],
            {
              encoding: 'utf-8',
              env: { ...process.env },
              cwd: dirname(claudeDir),
              timeout: STAGE_AUTO_DETECT_TIMEOUT_MS,
            },
          );
          const elapsedMs = Date.now() - spawnStart;
          if (res.status !== 0) {
            // Lock contention OR other error. Emit WARN and fall through;
            // downstream gate-enforcement still runs.
            // cr-style-b712ef9c: differentiate exit codes — signal vs status.
            //   null status + SIGTERM-ish elapsed ≥ timeout → timeout (lock contention typical)
            //   non-null status but non-zero            → checkpoint CLI crash or schema error
            const stderrSnippet = (res.stderr || '').slice(0, 200).replace(/\n+/g, ' ');
            let reason;
            if (res.status === null && elapsedMs >= STAGE_AUTO_DETECT_TIMEOUT_MS - 100) {
              reason = 'timeout (probable lock contention)';
            } else if (res.signal) {
              reason = `killed by signal ${res.signal}`;
            } else {
              reason = 'checkpoint CLI crash / non-zero exit';
            }
            process.stderr.write(
              `[workflow-gate-enforcement] WARN stage-auto-detect ${reason} exit=${res.status} signal=${res.signal ?? 'none'} elapsed=${elapsedMs}ms stderr=${stderrSnippet}\n`,
            );
          } else {
            process.stderr.write(
              `[workflow-gate-enforcement] stage-auto-detect: recorded stage=${parsed.stage} source=auto_detected elapsed=${elapsedMs}ms\n`,
            );
          }
        }
      }
      // parsed.reason === 'unparseable' / 'invalid_stage' -> silent fall-through
      // (operator may invoke explicit --stage CLI — existing path unchanged).
    }

    // Step 2: Check kill switch FIRST (REQ-021, AC-2.14)
    const killSwitchPath = join(coordinationDir, KILL_SWITCH_FILENAME);
    if (existsSync(killSwitchPath)) {
      // Security fix M3: audit trail for kill switch bypass
      process.stderr.write('[workflow-enforcement] WARNING: gate-enforcement-disabled is active -- enforcement bypassed\n');
      process.exit(0); // Kill switch active -- all enforcement disabled
    }

    // Step 3: Read session.json
    //
    // Dual-path lookup (sg-pipeline-efficiency-ws3 / as-007 AC7.1 fixture
    // alignment): The env-rooted path is the primary, but the cwd-rooted
    // path is a mandatory cross-check. When CLAUDE_PROJECT_DIR has been
    // mutated mid-session, the env-rooted session may be either absent
    // (decoy has no session) or pin-less (attacker redirects to a
    // pin-less session to bypass canon). In either case, the cwd-rooted
    // session must take precedence when it carries a `project_dir_pin`,
    // because cwd is the trust anchor set by the Claude Code host and
    // cannot be spoofed by env mutation. The pin-comparison at Step 4b
    // then correctly rejects the env mutation.
    //
    // Precedence rule: prefer whichever session carries a non-empty
    // `active_work.project_dir_pin`. If neither has a pin, use env-rooted
    // (preserves legacy-session fail-open semantics).
    const sessionPath = join(claudeDir, 'context', 'session.json');
    const envSession = loadSession(sessionPath);
    // worktree-canon dual-path: process.cwd() serves as trust-anchor for
    // session lookup (can't be spoofed by CLAUDE_PROJECT_DIR mutation).
    // The pin-comparison downstream (enforceEnvParity) drives the actual
    // canon enforcement — this read is metadata only.
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
      process.exit(0); // AC-2.9: Missing session.json -- fail-open
    }

    // Step 4: Check active_work exists
    // sg-enforcement-layer-gaps Task 26 / REQ-M2-003 / AC-8.4, AC-8.6:
    // Distinguish positive-assertion bypass from fail-open-on-missing.
    // When active_work is present with a recognized workflow → positive assertion.
    // When absent → uninitialized session fail-open (logged separately).
    if (!session.active_work) {
      process.stderr.write(
        '[workflow-gate-enforcement] event=no_active_work sub_type=' +
          (subagentType || 'unknown') +
          ' workflow=null assertion_state=missing exit=0_fail_open\n'
      );
      process.exit(0); // AC-2.10: Missing active_work -- fail-open
    }

    // Step 4b: Worktree-canon env-parity check (sg-pipeline-efficiency-ws3
    // / as-007 / REQ-007 / AC7.1).
    //
    // Invariant: if `session.active_work.project_dir_pin` is set, the current
    // `CLAUDE_PROJECT_DIR` MUST canonicalize to the same path. A mismatch
    // signals either (a) unauthorized mid-session env mutation (spoofing a
    // different worktree), or (b) a symlink-escape component. Either way →
    // block dispatch before downstream writes.
    //
    // Legacy-session guard (spec as-007 Task 4): when pin is absent (legacy
    // session pre-as-006) the enforcement is a no-op. This preserves zero-
    // regression behavior until as-006 captures the pin at `start-work`.
    //
    // The as-005 `worktree-canon` library is dynamically imported (matches
    // the `appendAuditEntry` lazy-import pattern at workflow-stop-enforcement
    // .mjs:239). If the module is absent (as-005 not yet landed) → fall
    // through with a stderr trace; hooks remain functional. Once as-005
    // lands, the env-parity check activates automatically.
    //
    // On violation → emit audit entry (`worktree_path_violation` event_class
    // per canonical 9-class enum, spec as-003) and exit 2 with structured
    // `WORKTREE_PATH_VIOLATION` stderr message.
    const projectDirPin = session.active_work.project_dir_pin;
    if (projectDirPin && typeof projectDirPin === 'string' && projectDirPin.length > 0) {
      try {
        const canonMod = await import('./lib/worktree-canon.mjs');
        canonMod.enforceEnvParity(projectDirPin);
      } catch (canonErr) {
        // ERR_MODULE_NOT_FOUND → as-005 not landed yet → legacy-session
        // equivalent fall-through. Every other error shape is a real
        // violation.
        const isMissingModule =
          canonErr &&
          (canonErr.code === 'ERR_MODULE_NOT_FOUND' ||
            /Cannot find module/.test(String(canonErr.message || '')));
        if (isMissingModule) {
          process.stderr.write(
            '[workflow-gate-enforcement] worktree-canon module absent -- env-parity check skipped\n'
          );
        } else {
          // Violation path. canonErr carries structured fields per as-005
          // error shape: { code, reason, attempted_path, pinned_root, exit_code }.
          const reason = canonErr.reason || 'unknown';
          // as-021 canon-lock: worktree-canon enforceEnvParity already
          // rejected; the process.env read is strictly for the error message.
          const attemptedPath = canonErr.attempted_path || process.env.CLAUDE_PROJECT_DIR || '<unset>';
          const code = canonErr.code || 'WORKTREE_PATH_VIOLATION';

          // Append audit entry (NFR-5 item e). Non-blocking on audit-append
          // failure; operator can reconcile from stderr.
          //
          // as-009 refactor (REQ-007 Task 2): route through the shared
          // `appendWorktreeAuditEntry` shim, which delegates to the
          // `logWorktreeViolation` helper in lib/worktree-canon-audit.mjs.
          // `event_subtype` becomes the violation reason (matches spec
          // contract); the hook label lands in the payload's `consumer`
          // field.
          try {
            const { appendWorktreeAuditEntry } = await import(
              './lib/worktree-enforcement.mjs'
            );
            // projectRoot anchor (as-007 AC7.1 fixture alignment): route the
            // audit write to the PINNED project's `.claude/audit/` directory
            // rather than CLAUDE_PROJECT_DIR's (which may be the spoofed
            // decoy). The pinned root is the source of truth for audit
            // observability — a spoofed env must not redirect the audit
            // trail away from the legitimate project's log.
            const result = await appendWorktreeAuditEntry(reason, {
              attempted_path: attemptedPath,
              pinned_root: projectDirPin,
              consumer: 'workflow-gate-enforcement',
              hook: 'workflow-gate-enforcement',
              subagent_type: subagentType || 'unknown',
              session_id: sessionId,
            }, { projectRoot: projectDirPin });
            if (!result || result.audited !== true) {
              process.stderr.write(
                `[workflow-gate-enforcement] WARNING: audit-append failed for WORKTREE_PATH_VIOLATION: ${result && result.error}\n`
              );
            }
          } catch (auditErr) {
            process.stderr.write(
              `[workflow-gate-enforcement] WARNING: audit-append failed for WORKTREE_PATH_VIOLATION: ${auditErr && auditErr.message}\n`
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

    // Step 5: Get workflow type (strict -- null means fail-open)
    const workflow = getWorkflowTypeStrict(session);
    if (!workflow) {
      process.stderr.write(
        '[workflow-gate-enforcement] event=invalid_workflow sub_type=' +
          (subagentType || 'unknown') +
          ' workflow=null assertion_state=invalid exit=0_fail_open\n'
      );
      process.exit(0); // No workflow set -- fail-open
    }

    // Step 6: Check exempt workflow (AC-2.8)
    // AC-8.4 / AC-8.6 — positive-assertion bypass, distinct log line from
    // fail-open-on-missing above.
    if (isExemptWorkflow(workflow)) {
      process.stderr.write(
        '[workflow-gate-enforcement] event=positive_assertion_bypass sub_type=' +
          (subagentType || 'unknown') +
          ' workflow=' +
          workflow +
          ' assertion_state=positive exit=0_exempt\n'
      );
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

    // Step 8b: Override each convergence prereq's required_count from the
    // session threshold snapshot (as-008 / REQ-012 / AC8.1).
    //
    // `getPrerequisites()` seeds `required_count` from the hardcoded
    // `REQUIRED_CLEAN_PASSES` constant in workflow-dag.mjs (grep-lock-locked
    // by as-011 / as-014). The consumer-side refactor reads
    // `required_clean_passes` from `session.active_work.threshold_snapshot`
    // and replaces the seed value; dispatch prerequisites that do NOT have
    // a convergence type (`dispatch`-type) are untouched.
    //
    // Fail-soft (AC8.3): when the snapshot is absent (pre-as-005 session)
    // or malformed, `readThresholdFromSnapshot()` returns the fallback (the
    // existing `required_count`) — block/allow semantics preserved.
    const effectivePrerequisites = prerequisites.map((prereq) => {
      if (prereq.type !== 'convergence') return prereq;
      const snapshotThreshold = readThresholdFromSnapshot(
        session,
        prereq.gate,
        prereq.required_count,
      );
      return snapshotThreshold === prereq.required_count
        ? prereq
        : { ...prereq, required_count: snapshotThreshold };
    });

    // Step 9: Check if prerequisites are met
    const result = werePrerequisitesMet(session, effectivePrerequisites);

    if (result.met) {
      // Step 9b: Optional evidence integrity verification (AC-4.1 through AC-4.5)
      // Advisory only -- warnings are logged but never block dispatch
      try {
        for (const prereq of effectivePrerequisites) {
          if (prereq.type === 'convergence') {
            const { warnings } = verifyEvidenceIntegrity(session, prereq.gate);
            for (const w of warnings) {
              process.stderr.write(w + '\n');
            }
          }
        }
      } catch {
        // AC-4.4: Fail-open on any verification error
      }
      process.exit(0); // All prerequisites met -- allow dispatch
    }

    // Step 10: Prerequisites not met -- check for override
    const overridePath = join(coordinationDir, OVERRIDE_FILENAME);
    const overrides = loadOverrides(overridePath);

    // ws-dag-substages / as-007c / AC7.1: inspect substage obligation for
    // the current session to surface missing-substage reason in the block
    // message. Advisory-only here; substage enforcement itself lives in
    // `transition-phase` (session-checkpoint.mjs).
    let missingSubstagesAdvisory = [];
    try {
      missingSubstagesAdvisory = getMissingRequiredSubstages(session, workflow);
    } catch {
      // Fail-open: substage-check is advisory; do not block dispatch on
      // validator-path errors.
      missingSubstagesAdvisory = [];
    }

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
      blockDispatch(subagentType, stillMissing, sessionId, missingSubstagesAdvisory);
    } else {
      // No overrides file -- block with all missing prerequisites
      blockDispatch(subagentType, result.missing, sessionId, missingSubstagesAdvisory);
    }
  } catch (err) {
    // AC-2.12: Top-level try/catch -- fail-open on any error
    process.stderr.write(`Error in workflow-gate-enforcement hook: ${err.message}\n`);
    process.exit(0);
  }
}

main();
