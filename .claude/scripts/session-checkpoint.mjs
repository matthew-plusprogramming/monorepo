#!/usr/bin/env node

/**
 * Session Checkpoint Utility
 *
 * Provides atomic updates to session.json for tracking orchestration state.
 * All operations are read-modify-write atomic to prevent corruption.
 *
 * Operations:
 *   init                                          - Initialize session.json if it doesn't exist
 *   start-work <spec_group_id> <workflow> <obj>   - Start tracking work on a spec group (positional)
 *     [--force-reset-convergence]                 - Explicit convergence reset (REQ-001.3 / as-009)
 *   start-work --exempt-workflow <W>              - Start tracking vibe-mode work (flag-only; auto-gen id+objective)
 *   rotate-worktree <new-root>                    - Facilitator-only re-pin of project_dir_pin (REQ-007 / as-006 / AC6.3)
 *   reconcile-convergence <spec_group_id>         - Run manifest-seed reconciliation on demand (REQ-007.3 / as-008)
 *   transition-phase <new_phase>                  - Update current phase (with DAG enforcement)
 *   complete-atomic-spec <atomic_spec_id>         - Mark an atomic spec as done
 *   dispatch-subagent <id> <type> <desc> [--stage]- Track subagent dispatch (--stage for challengers)
 *   complete-subagent <task_id> <result_summary>  - Mark subagent as complete
 *   clear-async-mode                              - Delete shape-lint-async-mode sentinel (AC-6.6)
 *   journal-created <path-to-journal>             - Mark journal entry as created
 *   override-skip --phase <p> --rationale "<r>"   - Override a phase skip block (main-agent-only)
 *   reset-enforcement --rationale "<r>"           - Reset all skip counters (main-agent-only)
 *   set-enforcement-level <level>                 - Change enforcement level (main-agent-only)
 *   override-enforcement <advisory|coercive> --rationale "<r>"
 *                                                 - Session-scoped enforcement flip (REQ-013 / as-019);
 *                                                   'off' rejected (SESSION_OVERRIDE_OFF_REJECTED).
 *   complete-work                                 - Finalize completed work (with completion checklist)
 *   archive-incomplete                            - Archive incomplete work to history
 *   record-test-writer-unlock <sg-id> --dispatch-id <id> --first-failure-ref <ref>
 *                                                 - Record bug-fix-mode test-writer unlock (ws-2 as-003).
 *                                                   Sole-writer for session.json.test_writer_unlock;
 *                                                   rejects feature-mode with UNLOCK_MODE_MISMATCH.
 *   fire-refence-trigger <sg-id> --trigger <label>
 *                                                 - Fire a re-fence trigger (version-bump, workstream-rotate)
 *                                                   that clears session.test_writer_unlock[<sg-id>] (ws-2 as-005).
 *                                                   Idempotent; appends test_writer_unlock_refence audit entry.
 *   record-deployment --target <t> --method <m>    - Record deployment activity (AC-1.1)
 *   record-deployment-failure                      - Record deployment failure (AC-2.1)
 *   record-deployment-clear-failure --service <s>  - Clear failure after env reconciliation (AC-14.3)
 *   get-status                                    - Output current session state summary (JSON)
 *   verify [--spec-group <id>]                    - Run five completion-invariant checks.
 *                                                   Distinct from update-convergence's
 *                                                   internal post-write verify step.
 *
 * Usage:
 *   node session-checkpoint.mjs <operation> [args...]
 *
 * Exit codes:
 *   0 - Success
 *   1 - Validation or operational error
 *
 * Two-Store Convergence Model: this script is the sole trusted writer for
 *   session.json:.convergence.<gate>.{clean_pass_count, parse_failed_count,
 *   iteration_count, sources[]} (session-scoped, live counters). When
 *   update-convergence verifies a gate, this script mirrors that result to the
 *   manifest convergence boolean. On `start-work` the stores are reconciled
 *   with "manifest wins" semantics.
 *   See .claude/docs/WORKFLOW-ENFORCEMENT.md § Two-Store Convergence Model.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  // ws-hook-firing: primitives for inline recordPass atomic-write helper (as-003..as-006)
  lstatSync,
  statSync,
  readdirSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
  constants as fsConstants,
  // sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-006 (AC6.3 CVG-001):
  // rotate-worktree pre-resolves facilitator-supplied symlinks so well-known
  // canonical directories (e.g., /tmp → /private/tmp on Darwin) succeed.
  realpathSync,
} from 'node:fs';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ORCHESTRATOR_PREDECESSORS,
  ONEOFF_SPEC_PREDECESSORS,
  EXEMPT_WORKFLOWS,
  VALID_PHASES,
  VALID_SUBAGENT_TYPES,
  VALID_RISK_TIERS,
  MANDATORY_DISPATCHES,
  REQUIRED_CHALLENGER_STAGES,
  VALID_CONVERGENCE_GATES,
  VALID_SUBSTAGES,
  REQUIRED_SUBSTAGES_BY_WORKFLOW,
  getWorkflowType,
  getWorkflowTypeStrict,
  getPredecessorGraph,
  wasPredecessorVisited,
  isExemptWorkflow,
  validateObligations,
  validateSubstages,
} from './lib/workflow-dag.mjs';
import {
  loadOverrides,
  findMatchingOverride,
} from './lib/hook-utils.mjs';
import { acquireLock, releaseLock } from './lib/session-lock.mjs';
import { atomicModifyJSON } from './lib/atomic-write.mjs';
import { computeFindingsHash } from './lib/findings-hash.mjs';
// sg-pipeline-efficiency-ws1-convergence-pruning / as-021 / REQ-011:
// Baseline-override lock inspection + force-release subcommands.
import {
  inspectBaselineOverrideLock,
  releaseBaselineOverrideLock,
  STALE_LOCK_THRESHOLD_MS,
  STALE_LOCK_RECOVERY,
} from './lib/baseline-override-lock.mjs';
// sg-pipeline-efficiency-ws1-convergence-pruning / as-005 (REQ-012)
// SessionThresholdSnapshot capture at start-work + immutability enforcement at
// every saveSession() call. buildSessionThresholdSnapshot() is invoked exactly
// once per session (inside opStartWork); assertSnapshotImmutable() runs on
// every persistence hop so subsequent writers cannot mutate the captured
// snapshot (AC5.4, AC5.5).
import {
  buildSessionThresholdSnapshot,
  assertSnapshotImmutable,
  EMPTY_STRING_SHA256,
  GENESIS_ANCHOR_RELATIVE_PATH,
} from './lib/snapshot-capture.mjs';
// sg-pipeline-efficiency-ws1-convergence-pruning / as-007 (REQ-012, NFR-16)
// Consumer 1 of 8 in the threshold-reader superset. Reads per-gate
// required_clean_passes from session.active_work.threshold_snapshot with
// graceful fallback to the legacy constant when the snapshot is absent
// (pre-as-005 sessions, exempt workflows). Shared with consumers 3-4
// (as-008 hook/enforcement pair); single canonical reader eliminates
// distributed consensus drift (Practice 1.10).
import { readThresholdFromSnapshot } from './lib/snapshot-threshold-reader.mjs';
// sg-pipeline-efficiency-ws1-convergence-pruning / as-013 (REQ-001, AC13.1..AC13.4)
// Phase-D attestation-skip + EC-7 conservative fallback.
//   - shouldSkipForAttestation(): pure decision helper used in
//     opUpdateConvergence to short-circuit to "1 clean + attestation" when
//     the gate's content-hash has not changed between the two most recent
//     clean passes.
//   - gateUsesContentHashAttestation(): gating predicate used at
//     recordPass() time so we only invoke the (fs-touching) hash helper for
//     gates actually configured with attestation_mode='content-hash'.
//   - resolveTableEntryForGate(): consumer-short -> canonical gate mapping +
//     PerGateThresholdTable entry lookup (for hash_input_manifest).
//   - ATTESTATION_DECISION: enum of skip/no-skip outcomes for log emission.
import {
  shouldSkipForAttestation,
  gateUsesContentHashAttestation,
  resolveTableEntryForGate,
  ATTESTATION_DECISION,
} from './lib/attestation-skip.mjs';
// sg-pipeline-efficiency-ws1-convergence-pruning / as-013 (AC13.2)
// Content-hash persistence at recordPass() time. Failures in the hash helper
// (HashInputError: missing file, git failure, unresolved placeholder) are
// trapped to a no-op: without a persisted content_hash the derive branch
// falls back to consecutive counting (EC-7), so a hash-compute failure never
// blocks convergence recording.
import { computeHashInputManifest } from './lib/hash-input-manifest.mjs';
import {
  checkConvergenceDepth,
  checkChallengerStages,
  checkPhaseDagPredecessors,
  checkArtifactInventory,
  checkConvergenceFieldSanity,
  formatConvergenceDepthFailure,
  formatChallengerStagesFailure,
  formatPhaseDagFailure,
  formatArtifactInventoryFailure,
  formatConvergenceSanityFailure,
} from './lib/stop-hook-checks.mjs';
import { validatePath, PATH_REJECT_REASONS } from './lib/path-validate.mjs';
// REQ-008 / as-011: single source of truth for atomic-spec ID regex.
// Replaces prior inline literal in validateAtomicSpecId (semantics identical).
import { ATOMIC_ID_REGEX } from './lib/atomic-id-schema.mjs';
import {
  registerActiveSession,
  unregisterActiveSession,
  snapshotLiveSessionIds,
  pruneDeadSessions,
  findOrphanSentinels,
} from './lib/active-sessions.mjs';
// sg-pipeline-efficiency-ws1-convergence-pruning / as-019 (REQ-013, EC-14)
// Session-scoped enforcement override (advisory ↔ coercive; off rejected).
  //   - sessionOverrideModeSchema (as-003) narrows the mode enum to reject 'off'
  //     at the boundary. Structured error SESSION_OVERRIDE_OFF_REJECTED emitted
  //     before generic validation so callers can branch
//     deterministically.
//   - getCurrentMode() (as-015) reads the file-based enforcement mode used as
//     the `prior_mode` payload field when no prior session override exists.
//   - appendAuditEntry() (as-017) appends event_class 'session_override_flip'
//     to the hash-chained audit log BEFORE mutating session scope; a failed
//     audit append never leaves a session with an override and no audit
//     record (mirrors opToggleKillSwitch ordering).
//   - SessionThresholdSnapshot is NOT mutated here (AC19.5); the override
//     lives at session.active_work.enforcement_override and is consumed by
//     downstream session-start flows (out of scope for this atomic spec).
import { sessionOverrideModeSchema } from './lib/schemas/enforcement-config.schema.mjs';

function sidecarUnavailable(name, cause) {
  return () => {
    const error = new Error(
      `${name} is unavailable; this command requires the sidecar module. ` +
        `Original error: ${cause?.message || String(cause)}`
    );
    error.cause = cause;
    throw error;
  };
}

function isDirectSidecarMissing(err, fileName) {
  return (
    err?.code === 'ERR_MODULE_NOT_FOUND' &&
    String(err?.url || err?.message || '').includes(fileName)
  );
}

let getCurrentMode = sidecarUnavailable(
  'pipeline-efficiency-enforcement-reader.mjs',
  new Error('module not loaded')
);
let appendAuditEntry = sidecarUnavailable(
  'pipeline-efficiency-audit-log.mjs',
  new Error('module not loaded')
);

try {
  ({ getCurrentMode } = await import('./pipeline-efficiency-enforcement-reader.mjs'));
} catch (err) {
  if (!isDirectSidecarMissing(err, 'pipeline-efficiency-enforcement-reader.mjs')) {
    throw err;
  }
  getCurrentMode = sidecarUnavailable(
    'pipeline-efficiency-enforcement-reader.mjs',
    err
  );
}

try {
  ({ appendAuditEntry } = await import('./pipeline-efficiency-audit-log.mjs'));
} catch (err) {
  if (!isDirectSidecarMissing(err, 'pipeline-efficiency-audit-log.mjs')) {
    throw err;
  }
  appendAuditEntry = sidecarUnavailable('pipeline-efficiency-audit-log.mjs', err);
}
// sg-pipeline-efficiency-ws2-practice-2.4 / as-003 / REQ-005 (AC-005.3, AC-005.7, AC-005.8)
// record-test-writer-unlock CLI — sole-writer entry point for
// session.json.test_writer_unlock[<sg-id>]. `mintMarker` (as-004) ships
// alongside as-003 (spec §Deployment Notes). Code-review Pass 1 M3: promoted
// from lazy `createRequire` resolve to a static ESM import now that the two
// atomic specs land together; the `globalThis.__testWriterUnlockMarkerStub`
// override path is retained below for test injection.
import { mintMarker as _mintMarkerReal } from './lib/test-writer-unlock-marker.mjs';

// sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-006 (REQ-007)
// Worktree-canon pin capture at start-work + rotate-worktree re-pin. The
// `capturePin` helper canonicalizes `CLAUDE_PROJECT_DIR` via `fs.realpath` +
// symlink-component rejection; `autoDetectCaseFS` probes case-insensitive FS
// once per session and caches the result in
// `session.active_work.case_insensitive_fs`. Both results are persisted by
// saveSession() before any downstream hook / agent reads the pin
// (as-007..as-010 consumers).
import {
  capturePin,
  autoDetectCaseFS,
  canonicalize,
  enforceEnvParity,
  validateAgainstPin,
  WorktreePathViolationError,
  WORKTREE_PATH_VIOLATION,
} from './lib/worktree-canon.mjs';

/**
 * Unicode codepoints that render as a slash but are NOT ASCII `/`. NFKC only
 * folds a few of these (U+FF0F FULLWIDTH SOLIDUS) to ASCII `/`; others
 * (U+2215 DIVISION SLASH, U+2044 FRACTION SLASH, U+29F8 BIG SOLIDUS) keep
 * their codepoint under NFKC. We replace them explicitly so both the gate
 * and validatePath see a canonical ASCII form.
 *
 * sec-pathval-c5f02103: this list is advisory — it covers the common
 * homoglyph surface seen in encoding-bypass research; new codepoints can
 * be appended here without touching path-validate.
 */
const SLASH_HOMOGLYPH_REGEX = /[\u2044\u2215\u29F8\uFF0F]/g;

/**
 * Apply encoded + unicode-homoglyph normalization to a candidate path string
 * so the downstream gate and validator see a canonical ASCII/POSIX form.
 *
 * sec-pathval-c5f02103: `path-validate.mjs` is POSIX-ASCII-only; it has no
 * awareness of URL-encoded traversals (`%2e%2e`) or unicode slash homoglyphs
 * (U+2215 DIVISION SLASH, U+2044 FRACTION SLASH, U+FF0F FULLWIDTH SOLIDUS).
 * Normalizing INSIDE session-checkpoint keeps the path-validate contract
 * narrow (lower blast radius) while still closing the bypass at the only
 * call site that takes agent-controlled strings as path candidates.
 *
 * Steps:
 *   1. `decodeURIComponent` — collapses `%2e%2e%2Fetc%2Fpasswd` → `../etc/passwd`.
 *      Malformed percent-escapes fall through silently (returns raw input).
 *   2. `String.prototype.normalize('NFKC')` — compatibility decomposition
 *      folds some homoglyph separators (e.g. U+FF0F → '/').
 *   3. Slash-homoglyph replacement — rewrites slashes that NFKC leaves
 *      intact (U+2215, U+2044, etc.) to ASCII '/' so path segments split
 *      correctly for the parent-traversal check.
 */
function normalizePathCandidate(s) {
  if (typeof s !== 'string') return s;
  let normalized = s;
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Malformed percent-escape — keep the current value.
  }
  try {
    normalized = normalized.normalize('NFKC');
  } catch {
    // normalize() should never throw on a valid string, but defense-in-depth.
  }
  // Replace slash homoglyphs that NFKC leaves intact.
  normalized = normalized.replace(SLASH_HOMOGLYPH_REGEX, '/');
  return normalized;
}

/**
 * Heuristic: treat a string as "path-like" when it contains a path separator
 * AND does not look like a sentence (no spaces in any path segment, no `:` or
 * `?` that typical URLs/IDs carry). This keeps the path-validate surface scoped
 * to spec-mandated boundaries (AC-1.6) without failing on normal descriptions
 * like "implement logout in src/auth.ts" (which has a separator but is a human
 * sentence).
 *
 * sec-pathval-c5f02103: The gate operates on the NORMALIZED candidate
 * (decodeURIComponent + NFKC) so encoded + homoglyph bypasses are caught.
 * The caller must also pass the normalized form to validatePath — see
 * opDispatchSubagent where both steps are paired.
 */
function looksLikeStandalonePath(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  const normalized = normalizePathCandidate(s);
  // Ignore if it contains whitespace — then it's a sentence, not a standalone path.
  if (/\s/.test(normalized)) return false;
  // Only treat as path when a separator exists OR the string contains `..`.
  return normalized.includes('/') || normalized.includes('\\') || normalized.includes('..');
}

// Schema version for session.json
const SESSION_VERSION = '1.0.0';

// VALID_PHASES imported from ./lib/workflow-dag.mjs
// (single source of truth -- includes 16 entries with awaiting_approval kept
// for backwards compatibility per AC-1.12 and auto_approval per AC-1.9)

// Valid workflow types
const VALID_WORKFLOWS = [
  'oneoff-vibe',
  'oneoff-spec',
  'orchestrator',
  'refactor',
  'journal-only'
];

// Valid challenger stage values (REQ-003, DEC-004).
//
// REQ-004 (sg-pipeline-efficiency-ws1-convergence-pruning / as-024): the
// review-phase challenger dispatch is deleted; the bare and namespaced
// stage strings are removed from this list so the module-boundary
// assertion in as-024 succeeds. Callers that accept an explicit stage
// string and validate against VALID_STAGES will now reject the deleted
// value — that is the intended failure mode.
const VALID_STAGES = [
  'pre-implementation',
  'pre-test',
  'pre-orchestration'
];

// VALID_SUBAGENT_TYPES imported from ./lib/workflow-dag.mjs

// =============================================================================
// Workflow Enforcement: DAG constants and query functions imported from shared module
// (ORCHESTRATOR_PREDECESSORS, ONEOFF_SPEC_PREDECESSORS, EXEMPT_WORKFLOWS,
//  MANDATORY_DISPATCHES, REQUIRED_CHALLENGER_STAGES imported from ./lib/workflow-dag.mjs)
// =============================================================================

// Per-session override cap shared between override-skip and reset-enforcement (REQ-008, REQ-009)
const MAX_OVERRIDES_PER_SESSION = 3;

// Maximum iterations per convergence gate before advisory cap warning
const MAX_CONVERGENCE_ITERATIONS = 5;

// Valid enforcement levels (REQ-010)
const VALID_ENFORCEMENT_LEVELS = ['off', 'warn-only', 'graduated'];

// Magic constant for enforcement_counter integrity checksum (REQ-012, EC-9)
const COUNTER_CHECKSUM_MAGIC = 0xA3F5;

/**
 * Compute a simple checksum for the enforcement_counter to detect out-of-band edits.
 * Returns the expected _counter_checksum value for a given counter.
 */
function computeCounterChecksum(counter) {
  return (counter ^ COUNTER_CHECKSUM_MAGIC);
}

/**
 * Verify enforcement_counter integrity by comparing stored checksum (REQ-012, EC-9).
 * If mismatch detected, emits a warning and degrades enforcement to warn-only mode.
 * Returns true if integrity check passed, false if mismatch detected.
 */
function verifyCounterIntegrity(session) {
  const checkpoint = session.phase_checkpoint;
  if (!checkpoint || checkpoint.enforcement_counter === undefined) {
    return true; // No counter to verify
  }
  const storedChecksum = checkpoint._counter_checksum;
  if (storedChecksum === undefined) {
    // No checksum yet (legacy session) -- initialize it
    checkpoint._counter_checksum = computeCounterChecksum(checkpoint.enforcement_counter);
    return true;
  }
  const expectedChecksum = computeCounterChecksum(checkpoint.enforcement_counter);
  if (storedChecksum !== expectedChecksum) {
    console.error(
      'Warning: Enforcement state integrity check failed: monotonic counter mismatch. ' +
      'Out-of-band session.json edit detected. Degrading to warn-only mode.'
    );
    checkpoint.enforcement_level = 'warn-only';
    // Re-sync checksum to current counter value so future operations are not stuck
    checkpoint._counter_checksum = expectedChecksum;
    return false;
  }
  return true;
}

// MANDATORY_DISPATCHES and REQUIRED_CHALLENGER_STAGES imported from ./lib/workflow-dag.mjs

// getPredecessorGraph and getWorkflowType imported from ./lib/workflow-dag.mjs

/**
 * Get enforcement level from session, with backward-compatible default.
 */
function getEnforcementLevel(session) {
  return session?.phase_checkpoint?.enforcement_level || 'graduated';
}

// wasPredecessorVisited imported from ./lib/workflow-dag.mjs

/**
 * Check if the main agent is calling (no subagents in-flight).
 * Used for access control on override-skip, reset-enforcement, enforcement level changes.
 */
function isMainAgent(session) {
  return (session.subagent_tasks?.in_flight || []).length === 0;
}

/**
 * Find the .claude directory by walking up from script location.
 */
function findClaudeDir() {
  let currentDir = dirname(resolve(import.meta.url.replace('file://', '')));
  const root = '/';

  while (currentDir !== root) {
    const claudeDir = join(currentDir, '.claude');
    if (existsSync(claudeDir)) {
      return claudeDir;
    }
    if (basename(currentDir) === '.claude') {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return join(process.cwd(), '.claude');
}

const CLAUDE_DIR = findClaudeDir();
const CONTEXT_DIR = join(CLAUDE_DIR, 'context');
const SESSION_PATH = join(CONTEXT_DIR, 'session.json');

/**
 * Get current ISO 8601 timestamp.
 */
function now() {
  return new Date().toISOString();
}

/**
 * Generate a unique task ID.
 */
function generateTaskId() {
  return `task-${randomUUID()}`;
}

/**
 * Ensure the context directory exists.
 */
function ensureContextDir() {
  if (!existsSync(CONTEXT_DIR)) {
    mkdirSync(CONTEXT_DIR, { recursive: true });
  }
}

/**
 * Load session.json, returning null if it doesn't exist.
 * AC-1.9: On corrupt JSON, returns null so caller can create fresh session.
 */
function loadSession() {
  if (!existsSync(SESSION_PATH)) {
    return null;
  }

  try {
    const content = readFileSync(SESSION_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    // AC-1.9: Corrupt JSON -- return null for fresh session creation
    console.error(`Error loading session.json (corrupt JSON): ${err.message}. Will create fresh session.`);
    return null;
  }
}

/** Path to the session.json lockfile. */
const LOCK_PATH = SESSION_PATH + '.lock';

/**
 * Save session.json atomically using lockfile + write-to-temp-then-rename.
 * AC-1.8: Atomic write via temp file + rename
 * AC-1.11: Lockfile with PID and timestamp
 * AC-1.10: Corruption recovery on rename failure
 *
 * @param {session} session - Session object to save
 * @param {object} [opts] - Options
 * @param {boolean} [opts.failOpen=false] - Lock failure behavior (default: fail-closed for CLI)
 * @param {boolean} [opts.allowSnapshotLifecycleReset=false] - Allow complete/archive/clear-dangling to clear or replace active_work after snapshot capture
 */
function saveSession(session, opts = {}) {
  ensureContextDir();
  session.updated_at = now();

  const failOpen = opts.failOpen !== undefined ? opts.failOpen : false;
  const lockAcquired = acquireLock(LOCK_PATH, { failOpen });
  if (!lockAcquired) {
    if (failOpen) {
      console.error('[session-checkpoint] WARNING: Could not acquire lock -- skipping write (fail-open)');
      return;
    }
    // fail-closed: acquireLock throws
  }

  try {
    // sg-pipeline-efficiency-ws1-convergence-pruning / as-005 (REQ-012 / AC5.4)
    // SessionThresholdSnapshot immutability enforcement.
    //
    // Re-read the on-disk session under the lock and compare its captured
    // snapshot to the in-memory one. If the on-disk snapshot exists, the
    // incoming session MUST carry the same snapshot (or otherwise be
    // rejected). Reading under the lock avoids a race with concurrent
    // writers; start-work's own initial capture passes trivially because the
    // on-disk session has no snapshot yet.
    let previousOnDisk = null;
    try {
      if (existsSync(SESSION_PATH)) {
        const prevRaw = readFileSync(SESSION_PATH, 'utf-8');
        previousOnDisk = JSON.parse(prevRaw);
      }
    } catch {
      // Corrupt or unreadable session.json: treat as "no prior snapshot".
      // loadSession() already swallows this error path upstream; the
      // immutability check can't enforce against data it cannot read.
      previousOnDisk = null;
    }
    assertSnapshotImmutable(session, previousOnDisk, {
      allowLifecycleReset: opts.allowSnapshotLifecycleReset === true,
    });

    const data = JSON.stringify(session, null, 2) + '\n';
    const tempPath = SESSION_PATH + '.tmp.' + process.pid;
    writeFileSync(tempPath, data);
    try {
      renameSync(tempPath, SESSION_PATH);
    } catch (renameErr) {
      // AC-1.10: Rename failure -- corruption recovery
      console.error(
        `[session-checkpoint] ERROR: Atomic rename failed -- OS error: ${renameErr.code || renameErr.message}, ` +
        `source: ${tempPath}, target: ${SESSION_PATH}. Creating fresh session.`
      );
      const freshSession = createEmptySession();
      writeFileSync(SESSION_PATH, JSON.stringify(freshSession, null, 2) + '\n');
    }
  } finally {
    releaseLock(LOCK_PATH);
  }
}

/**
 * Create a new empty session object.
 */
function createEmptySession() {
  return {
    version: SESSION_VERSION,
    updated_at: now(),
    active_work: null,
    phase_checkpoint: null,
    subagent_tasks: {
      in_flight: [],
      completed_this_session: []
    },
    history: []
  };
}

/**
 * Add a history entry to the session.
 */
function addHistoryEntry(session, eventType, details = {}) {
  session.history.push({
    timestamp: now(),
    event_type: eventType,
    details
  });
}

/**
 * Validate phase is a valid phase enum value.
 */
function validatePhase(phase) {
  if (!VALID_PHASES.includes(phase)) {
    throw new Error(`Invalid phase '${phase}'. Valid phases: ${VALID_PHASES.join(', ')}`);
  }
}

/**
 * Validate workflow is a valid workflow enum value.
 */
function validateWorkflow(workflow) {
  if (!VALID_WORKFLOWS.includes(workflow)) {
    throw new Error(`Invalid workflow '${workflow}'. Valid workflows: ${VALID_WORKFLOWS.join(', ')}`);
  }
}

/**
 * Validate subagent type is a valid enum value.
 */
function validateSubagentType(type) {
  if (!VALID_SUBAGENT_TYPES.includes(type)) {
    throw new Error(`Invalid subagent type '${type}'. Valid types: ${VALID_SUBAGENT_TYPES.join(', ')}`);
  }
}

// =============================================================================
// Substage tracking (sg-workflow-convergence-bugs / ws-dag-substages / as-002c)
// =============================================================================

/**
 * Error code emitted when a workflow downgrade is attempted mid-session.
 * Spec: ws-dag-substages as-004c / AC-C7 / NFR-21.
 * @type {string}
 */
const WORKFLOW_IMMUTABLE_ERROR_CODE = 'WORKFLOW_IMMUTABLE';

/**
 * Normalize a challenger stage value to its short canonical form for
 * `substages_visited` array storage.
 *
 * Accepted long and short forms:
 *   'pre-implementation'  -> 'pre-impl'
 *   'pre-orchestration'   -> 'pre-orch'
 *   'pre-test'            -> 'pre-test'
 *
 * REQ-004 (as-024): the previously-supported review-phase challenger
 * substage mapping is removed — that dispatch is deleted and the short
 * form no longer appears in VALID_SUBSTAGES. Any other value is returned
 * unchanged (caller validates against VALID_SUBSTAGES before storing).
 *
 * @param {string|null|undefined} stage
 * @returns {string|null}
 */
function normalizeSubstage(stage) {
  if (!stage || typeof stage !== 'string') return null;
  if (stage === 'pre-implementation') return 'pre-impl';
  if (stage === 'pre-orchestration') return 'pre-orch';
  return stage;
}

/**
 * Populate session.substages_visited.<phase> with the given substage (deduped),
 * emit `dag.substage.admitted` structured log.
 *
 * Backfills `substages_visited = {}` when absent (F-C9 in-flight migration).
 * Per R-021 / NFR-19 sole-writer invariant: this is the ONLY call site that
 * mutates session.substages_visited.
 *
 * Spec: sg-workflow-convergence-bugs / ws-dag-substages / as-002c.
 * Requirements: REQ-011, REQ-014, REQ-019, REQ-021.
 *
 * @param {object} session - Mutable session object
 * @param {string} phase - Phase for which this substage belongs ('challenging')
 * @param {string} substage - Short-form substage (validated by caller against VALID_SUBSTAGES)
 */
function populateSubstageVisited(session, phase, substage) {
  // F-C9 backfill: initialize absent or malformed top-level to {} before
  // writing. This makes the populate path tolerant of in-flight sessions
  // that pre-date the as-002c landing. The obligation check (as-003c)
  // handles malformed shapes independently.
  if (!session.substages_visited || typeof session.substages_visited !== 'object' || Array.isArray(session.substages_visited)) {
    session.substages_visited = {};
  }
  if (!Array.isArray(session.substages_visited[phase])) {
    session.substages_visited[phase] = [];
  }
  const visited = session.substages_visited[phase];
  if (!visited.includes(substage)) {
    visited.push(substage);
  }

  // Emit dag.substage.admitted per EC-C7 (audit-trail: emit on each call,
  // dedup is on the set, not on log emission).
  try {
    process.stderr.write(JSON.stringify({
      event: 'dag.substage.admitted',
      phase,
      substage,
      session_id: hashSessionIdForAdmittedLog(session?.session_id),
    }) + '\n');
  } catch {
    // Never throw from log emission.
  }
}

/**
 * Hash a session_id for dag.substage.admitted log emission. 16-char hex
 * SHA-256 prefix. Mirrors hashSessionId() below (which is defined later in
 * this file; this wrapper exists to keep the populate path self-contained).
 *
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
function hashSessionIdForAdmittedLog(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return '<unknown>';
  try {
    return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  } catch {
    return '<unknown>';
  }
}

/**
 * Check for WORKFLOW_IMMUTABLE violation.
 *
 * Compares the requested workflow parameter to session.active_work.workflow.
 * Returns an Error object when the two differ (and neither is exempt);
 * returns null when the requested workflow is null, matches, or current
 * workflow is exempt.
 *
 * Caller is responsible for exiting (process.exit / throw) AFTER logging
 * the structured error — this function is pure read-only.
 *
 * Spec: ws-dag-substages / as-004c / AC4.3 / AC-C7 / NFR-21.
 *
 * @param {object} session - Loaded session object (must have active_work)
 * @param {string|null} requestedWorkflow - Workflow value from caller
 * @returns {Error|null}
 */
function checkWorkflowImmutable(session, requestedWorkflow) {
  if (requestedWorkflow === null || requestedWorkflow === undefined) return null;
  const currentWorkflow = session?.active_work?.workflow;
  if (!currentWorkflow) return null; // first-set is not a downgrade
  if (currentWorkflow === requestedWorkflow) return null; // no change
  // Exempt current workflows bypass (NFR-21 + existing EXEMPT_WORKFLOWS list).
  if (EXEMPT_WORKFLOWS.includes(currentWorkflow)) return null;
  // Log the immutability violation to stderr (structured log).
  try {
    process.stderr.write(JSON.stringify({
      event: WORKFLOW_IMMUTABLE_ERROR_CODE,
      current: currentWorkflow,
      requested: requestedWorkflow,
      session_id: hashSessionIdForAdmittedLog(session?.session_id),
    }) + '\n');
  } catch {
    // Never throw from log emission.
  }
  return new Error(
    `${WORKFLOW_IMMUTABLE_ERROR_CODE}: cannot change workflow mid-session ` +
    `(current: ${currentWorkflow}, requested: ${requestedWorkflow}). ` +
    `Run complete-work or archive-incomplete first.`
  );
}

/**
 * Validate spec group ID format.
 */
function validateSpecGroupId(id) {
  if (!id || !/^sg-[a-z0-9.-]+$/.test(id)) {
    throw new Error(`Invalid spec_group_id '${id}'. Must match pattern 'sg-[a-z0-9.-]+'`);
  }
}

/**
 * Validate atomic spec ID format.
 *
 * REQ-008 / as-011: regex sourced from `./lib/atomic-id-schema.mjs` single
 * source of truth — semantics identical to the prior inline literal.
 */
function validateAtomicSpecId(id) {
  if (!id || !ATOMIC_ID_REGEX.test(id)) {
    throw new Error(`Invalid atomic_spec_id '${id}'. Must match pattern 'as-NNN' or 'as-NNN-slug'`);
  }
}

// =============================================================================
// Two-Store Convergence Reconciliation
// =============================================================================

/**
 * Convergence seed target: the threshold value written to session.json when
 * the manifest records a gate as converged but the session has no recorded
 * passes. Two consecutive clean passes is the convergence contract, so the
 * seed value matches the contract.
 */
const CONVERGENCE_SEED_THRESHOLD = 2;

/**
 * Fixed error text emitted when both manifest.json and session.json are
 * unreadable/corrupt at start-work time. Matches spec verbatim.
 */
const E_DUAL_CORRUPT_MESSAGE =
  'E_DUAL_CORRUPT: both manifest.json and session.json unreadable; manual recovery required';

/**
 * Read and parse a JSON file.
 * Returns {ok, value, error, absent} so callers can distinguish
 * - absent (file does not exist) from
 * - parse failure (unreadable/corrupt content).
 *
 * Used by the dual-corrupt guard (as-011) and the manifest-seed reconciliation
 * helper (as-008). Kept local rather than re-using loadSession() because
 * loadSession swallows parse failures as null, which is indistinguishable
 * from absence and would defeat EC-15 detection.
 */
function tryReadJson(path) {
  if (!existsSync(path)) {
    return { ok: false, value: null, error: null, absent: true };
  }
  try {
    const content = readFileSync(path, 'utf-8');
    return { ok: true, value: JSON.parse(content), error: null, absent: false };
  } catch (err) {
    return { ok: false, value: null, error: err, absent: false };
  }
}

/**
 * Resolve the manifest path for a spec group without touching the filesystem.
 * Exposed so the dual-corrupt guard can reference the path consistently
 * with opStartWork's downstream code.
 */
function manifestPathFor(specGroupId) {
  return join(CLAUDE_DIR, 'specs', 'groups', specGroupId, 'manifest.json');
}

const VERIFIED_CONVERGENCE_MANIFEST_FIELDS = Object.freeze({
  investigation: 'investigation_converged',
  challenger: 'challenger_converged',
  unifier: 'unifier_passed',
  code_review: 'code_review_passed',
  security_review: 'security_review_passed',
  completion_verifier: 'completion_verification_passed',
});

/**
 * Persist verified session convergence to the manifest gate boolean.
 *
 * This is the narrow bridge between evidence-derived session state and the
 * manifest fields consumed by phase obligations. It only runs after
 * update-convergence's post-write verification has passed.
 */
function mirrorVerifiedConvergenceToManifest(session, gateName, verifiedCount) {
  const field = VERIFIED_CONVERGENCE_MANIFEST_FIELDS[gateName];
  if (!field) {
    return { ok: true, changed: false, reason: 'unmapped_gate' };
  }

  const specGroupId = session?.active_work?.spec_group_id;
  if (!specGroupId) {
    return { ok: true, changed: false, reason: 'missing_spec_group_id' };
  }

  try {
    validateSpecGroupId(specGroupId);
  } catch (err) {
    return { ok: false, changed: false, reason: err.message };
  }

  const mPath = manifestPathFor(specGroupId);
  const existing = tryReadJson(mPath);
  if (!existing.ok) {
    return {
      ok: existing.absent,
      changed: false,
      reason: existing.absent ? 'manifest_absent' : `manifest_unreadable: ${existing.error?.message || 'unknown'}`,
    };
  }

  if (existing.value?.convergence?.[field] === true) {
    return { ok: true, changed: false, reason: 'already_true' };
  }

  let changed = false;
  let written = false;
  try {
    written = atomicModifyJSON(mPath, (current) => {
      if (!current || typeof current !== 'object') {
        throw new Error('manifest unreadable during convergence mirror');
      }
      if (!current.convergence) {
        current.convergence = {};
      }
      if (current.convergence[field] === true) {
        return current;
      }

      current.convergence[field] = true;
      if (!Array.isArray(current.decision_log)) {
        current.decision_log = [];
      }
      current.decision_log.push({
        timestamp: now(),
        actor: 'session-checkpoint',
        action: 'convergence_verified',
        gate_name: gateName,
        details: `Verified ${gateName} from session evidence; set convergence.${field}=true`,
        clean_pass_count: verifiedCount,
      });
      current.updated_at = now();
      changed = true;
      return current;
    }, { failOpen: false });
  } catch (err) {
    return {
      ok: false,
      changed: false,
      reason: err?.message || 'manifest_write_exception',
    };
  }

  return {
    ok: Boolean(written),
    changed,
    reason: written ? null : 'manifest_write_failed',
  };
}

/**
 * Emit a `dual_corrupt` audit entry via audit-append.mjs if the CLI exists
 * (Phase C dependency). If absent, a no-op so the stderr-only fail-closed
 * path (as-011) continues to work additively.
 *
 * Returns { invoked: bool, reason: string|null } for observability.
 * Never throws; audit emission MUST NOT block the fail-closed exit.
 */
function tryEmitDualCorruptAudit(context = {}) {
  const auditCliPath = join(CLAUDE_DIR, 'scripts', 'audit-append.mjs');
  if (!existsSync(auditCliPath)) {
    return { invoked: false, reason: 'audit-append.mjs not present (Phase C dependency)' };
  }
  // audit-append.mjs API will be finalized in as-018. For now, best-effort
  // fire-and-forget subprocess call. If it fails or is not yet wired for
  // this action, swallow the error and continue the fail-closed exit.
  try {
    const res = spawnSync('node', [
      auditCliPath,
      '--action', 'dual_corrupt',
      '--actor', 'session-checkpoint',
      '--rationale', context.rationale || 'dual-corrupt at start-work',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { invoked: true, reason: res.status === 0 ? 'audit appended' : `audit-append exited ${res.status}` };
  } catch (err) {
    return { invoked: false, reason: `audit-append invocation failed: ${err.message}` };
  }
}

// =============================================================================
// Convergence-state reconciliation support
// =============================================================================

/**
 * Window size for the index-based recent-pass preservation check.
 * A `convergence_pass_recorded` entry within the last 3 history positions
 * counts as "recent" and prevents manifest-seed overwrite of the session
 * counter for that gate.
 */
const RECENT_PASS_WINDOW_SIZE = 3;

/**
 * Canonical VALIDATION-SKIP stderr shape. Single-quoted values; field order
 * is fixed: gate then reason then spec_group. Grep-stable anchor.
 * Regex for assertions:
 *   ^VALIDATION-SKIP: gate='[a-z_]+' reason='[a-z_]+' spec_group='[a-z0-9-]+'$
 */
const VALIDATION_SKIP_REASONS = Object.freeze({
  NON_BOOLEAN_VALUE: 'non_boolean_value',
});

/**
 * cr-error-code-a4c1b8e2: Canonical error-code enum for ReconcileOptsError.
 * Parallels VALIDATION_SKIP_REASONS above — grep-stable, extension-friendly.
 * Reference codes as RECONCILE_ERROR_CODES.<NAME> rather than inline literals.
 */
const RECONCILE_ERROR_CODES = Object.freeze({
  MISSING_SPEC_GROUP_ID: 'RECONCILE_OPTS_MISSING_SPEC_GROUP_ID',
  // future codes here
});

/**
 * Typed error for reconcile opts mis-wiring. Thrown when a caller invokes
 * reconcileConvergenceFromManifest without a spec_group_id field, which is
 * required for EC-18 precedence scoping (force_reset_reconcile_skip lookups).
 */
class ReconcileOptsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconcileOptsError';
    this.code = code;
  }
}

/**
 * Typed error for session-scoped enforcement override failures.
 *
 * sec-authz-c8e51f33 (security-review pass 1 Medium, accepted as
 * security-risk acknowledgment):
 *   `opOverrideEnforcement` previously threw plain `Error` instances whose
 *   only discriminator was a substring prefix in `.message` (e.g.
 *   'SESSION_OVERRIDE_OFF_REJECTED: ...'). This forced callers to do brittle
 *   string matching and masked the code-vs-message distinction consumers
 *   rely on for structured log emission (same pattern as RecordPassError).
 *
 * Known codes:
 *   SESSION_OVERRIDE_OFF_REJECTED — AC19.3 (operator-signed-only 'off').
 *   SESSION_OVERRIDE_INVALID_MODE — Zod enum rejection for unknown mode.
 *   SESSION_OVERRIDE_USAGE_ERROR  — missing mode / rationale / malformed call.
 *   SENTINEL_ACTIVE               — kill-switch sentinel present; ALL
 *                                   enforcement is bypassed, including
 *                                   session overrides (defense-in-depth).
 *
 * @param {string} code — stable machine-readable code from the list above
 * @param {string} message — operator-facing human-readable description
 */
export class SessionOverrideError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionOverrideError';
    this.code = code;
  }
}

/**
 * Structured error for `record-test-writer-unlock` CLI. Callers branch on
 * `.code`; the message also carries the code as a prefix token for stderr-
 * grep parity (mirrors SessionOverrideError convention).
 *
 * Codes (stable discriminators, spec.md § Interfaces & Contracts):
 *   UNLOCK_USAGE_ERROR          — missing/invalid required flag
 *   UNLOCK_MODE_MISMATCH        — spec_mode absent OR != 'bug-fix' (AC-005.7)
 *   UNLOCK_MANIFEST_MISSING     — manifest.json not present for sg-id
 *   UNLOCK_MANIFEST_CORRUPT     — manifest.json unreadable / invalid JSON
 *   UNLOCK_SESSION_MISSING      — session.json absent; run `init` first
 *   UNLOCK_SESSION_NO_ACTIVE_WORK — session has no active_work
 *   UNLOCK_HMAC_SECRET_ERROR    — secret file IO / mode-enforcement failure
 *   UNLOCK_AUDIT_APPEND_FAILED  — audit chain append failed (see payload)
 *   GENESIS_ANCHOR_INVALID      — hash-chain genesis anchor missing/invalid
 *                                 (as-007 AC7.3: fail-closed exit 2; unlock REJECTED)
 *
 * sg-pipeline-efficiency-ws2-practice-2.4 / as-003 / REQ-005.
 */
export class TestWriterUnlockError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TestWriterUnlockError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Structured error for `record-route-decision` CLI. Callers branch on
 * `.code`; the message carries the code as a prefix token so stderr-grep
 * tests stay stable (mirrors TestWriterUnlockError / SessionOverrideError
 * conventions).
 *
 * Codes (stable discriminators for record-route-decision):
 *   ROUTE_DECISION_USAGE_ERROR             — missing / invalid required arg
 *   ROUTE_DECISION_WORKFLOW_INVALID        — workflow not in VALID_WORKFLOWS
 *   ROUTE_DECISION_RATIONALE_INVALID       — rationale missing or empty
 *   ROUTE_DECISION_JUSTIFICATION_INVALID   — justification JSON malformed or
 *                                            does not match contract shape
 *   ROUTE_DECISION_JUSTIFICATION_REQUIRED  — orchestrator without justification
 *   ROUTE_DECISION_JUSTIFICATION_FORBIDDEN — non-orchestrator with justification
 *   ROUTE_DECISION_RISK_TIER_INVALID       — risk tier not in VALID_RISK_TIERS
 *   ROUTE_DECISION_SESSION_MISSING         — session.json absent; run `init`
 *   ROUTE_DECISION_LOCK_FAILED             — session.json lock acquisition failed
 *   ROUTE_DECISION_WRITE_FAILED            — atomic-modify write failed
 *
 * Owner: .claude/docs/ROUTING.md.
 */
export class RouteDecisionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RouteDecisionError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Absolute path to the pipeline-efficiency kill-switch sentinel.
 *
 * Presence of this file means the operator has explicitly disabled all
 * pipeline-efficiency enforcement via signed commit (NFR-14, spec
 * §Kill-Switch Protocol). When present, session-scoped overrides are
 * rejected with `SENTINEL_ACTIVE` so the session cannot re-engage coercive
 * enforcement behind the operator's back.
 *
 * @see `.claude/scripts/workflow-file-protection.mjs` basename registration.
 * @see sec-authz-c8e51f33.
 */
const PIPELINE_EFFICIENCY_KILL_SWITCH_PATH = join(
  CLAUDE_DIR,
  'coordination',
  'pipeline-efficiency-disabled'
);

/**
 * Emit a grep-stable VALIDATION-SKIP stderr line.
 * Shape: `VALIDATION-SKIP: gate='<g>' reason='<r>' spec_group='<sg>'`
 * Optionally prefixed with `[dry-run] ` when dryRun is true.
 */
function emitValidationSkip(gate, reasonCode, specGroupId, dryRun) {
  const prefix = dryRun ? '[dry-run] ' : '';
  process.stderr.write(
    `${prefix}VALIDATION-SKIP: gate='${gate}' reason='${reasonCode}' spec_group='${specGroupId}'\n`
  );
}

/**
 * Convergence-state reconciliation: recent-pass preservation, force-reset
 * precedence, strict validation, and dry-run behavior.
 *
 * Reconcile manifest vs session.json convergence state using the "manifest
 * wins" rule documented in WORKFLOW-ENFORCEMENT.md § Two-Store Convergence
 * Model § (d). For each gate in VALID_CONVERGENCE_GATES, if
 *   manifest.convergence.<gate>_converged === true
 *   AND session.convergence.<gate>.clean_pass_count < 2
 * the helper:
 *   1. Emits a WARN log naming both values.
 *   2. Seeds session.convergence.<gate>.clean_pass_count to the threshold (2).
 *   3. Appends a sources[] entry with record_source: "manifest_seed".
 *
 * Precedence order (tasks T-04 -> T-03):
 *   - EC-18: force_reset_reconcile_skip[opts.spec_group_id] fresh session ⇒
 *     SHORT-CIRCUIT before per-gate loop. No EC-14 eval, no seeds.
 *   - Per-gate loop:
 *       * Strict validation (T-06): non-boolean manifest value ⇒ VALIDATION-SKIP
 *         line, continue (per-gate fail-open).
 *       * EC-14 (T-03): recent convergence_pass_recorded entry for this gate
 *         within last RECENT_PASS_WINDOW_SIZE history positions + manifest
 *         false + session count 0 ⇒ preserve counter (no seed) + emit stderr
 *         + append audit history entry.
 *       * Legacy manifest-seed branch when manifest true + session count < 2.
 *
 * @param {object} session - Session state object (mutated)
 * @param {object} manifest - Manifest state object (read-only)
 * @param {object} opts
 * @param {string} opts.spec_group_id - REQUIRED. Used for force_reset_reconcile_skip
 *   lookup (EC-18) and for VALIDATION-SKIP / audit history context.
 * @param {string} [opts.context] - 'start-work' | 'manual-cli' (default 'start-work')
 * @param {boolean} [opts.dryRun] - when true, no session mutation; stderr prefixed
 *   with `[dry-run]`. Used by `reconcile-convergence --dry-run`.
 * @returns {Array} events[] for caller observability (history logging)
 * @throws {ReconcileOptsError} when opts.spec_group_id is missing (T-04 contract)
 */
function reconcileConvergenceFromManifest(session, manifest, opts = {}) {
  const events = [];
  const context = opts.context || 'start-work';
  const dryRun = opts.dryRun === true;
  const specGroupId = opts.spec_group_id;

  // T-04 / AC-7.3: opts.spec_group_id is REQUIRED. Throw defensively to protect
  // against mis-wired callers. Both existing callers (opStartWork reconcile
  // branch, opReconcileConvergence manual-cli entry) MUST thread spec_group_id.
  // cr-brittle-lineref-d9e3a4f5: reference callers by function name rather
  // than line number — line numbers drift as the file evolves.
  if (!specGroupId || typeof specGroupId !== 'string') {
    throw new ReconcileOptsError(
      RECONCILE_ERROR_CODES.MISSING_SPEC_GROUP_ID,
      'reconcileConvergenceFromManifest: opts.spec_group_id is required ' +
      '(convergence-state reconciliation requires opts.spec_group_id). Both callers ' +
      '(`opStartWork` reconcile branch, `opReconcileConvergence`) must ' +
      'pass spec_group_id via opts.'
    );
  }

  // EC-3 / EC-13 graceful fallthrough: no manifest, no convergence object, or
  // no convergence fields at all ⇒ no-op (no seeds, no stderr, no history).
  if (!manifest || typeof manifest !== 'object' || !manifest.convergence) {
    return events;
  }

  // T-04 / AC-7.1 + AC-7.2 + AC-18.1: EC-18 precedence.
  // force_reset_reconcile_skip[<spec_group_id>] exists with session_id
  // matching current session.session_id ⇒ FRESH entry ⇒ short-circuit before
  // any per-gate evaluation (EC-18 wins over EC-14). Stale entry (mismatched
  // session_id) ⇒ clear in-place lazily and proceed normally.
  const skipMap = session.force_reset_reconcile_skip;
  if (skipMap && typeof skipMap === 'object' && skipMap[specGroupId]) {
    const skipEntry = skipMap[specGroupId];
    const currentSessionId = session.session_id;
    if (skipEntry && skipEntry.session_id && skipEntry.session_id === currentSessionId) {
      // Fresh force-reset skip: short-circuit before per-gate loop.
      const prefix = dryRun ? '[dry-run] ' : '';
      process.stderr.write(
        `${prefix}[session-checkpoint] force-reset skip active for spec_group='${specGroupId}' ` +
        `-- reconciliation bypassed (session_id match).\n`
      );
      return events;
    }
    // Stale entry: different session_id. Clear lazily (AC-18.1) and proceed.
    if (!dryRun) {
      delete session.force_reset_reconcile_skip[specGroupId];
    }
  }

  const manifestConv = manifest.convergence;

  for (const gate of VALID_CONVERGENCE_GATES) {
    const convergedKey = `${gate}_converged`;
    const manifestValue = manifestConv[convergedKey];

    // EC-4 / AC-45.2 / AC-49.2: field not present on manifest ⇒ skip (no
    // VALIDATION-SKIP emission; silent forward-compat pass-through).
    if (manifestValue === undefined) {
      continue;
    }

    // T-06 / AC-32.1 / AC-32.2 / AC-39.1: strict-boolean validation.
    // Accept only strict `true` or `false`; any other type emits a grep-stable
    // VALIDATION-SKIP line and continues the loop (per-gate fail-open).
    if (manifestValue !== true && manifestValue !== false) {
      emitValidationSkip(gate, VALIDATION_SKIP_REASONS.NON_BOOLEAN_VALUE, specGroupId, dryRun);
      continue;
    }

    // Read session-side count with legacy-compat defaults (NFR-3).
    const sessionConv = session.convergence ?? {};
    const gateState = sessionConv[gate] ?? {};
    const sessionCount = typeof gateState.clean_pass_count === 'number'
      ? gateState.clean_pass_count
      : 0;

    const manifestConverged = manifestValue === true;

    // T-03 / AC-8.1 / AC-8.2 / AC-8.3 / AC-8.4: EC-14 recent-pass preservation.
    // Guard chain:
    //   - history.length >= RECENT_PASS_WINDOW_SIZE (floor guard; AC-8.3)
    //   - last_pass_history_index !== undefined (AC-8.4 precondition)
    //   - last_pass_history_index >= history.length - RECENT_PASS_WINDOW_SIZE
    //   - history[last_pass_history_index].event_type === 'convergence_pass_recorded'
    //   - manifest false AND session count 0 (drift-lag condition)
    // On match: preserve counter (no seed), emit stderr, append audit history.
    //
    // Hook-not-firing graceful degradation (AC-8.4): if last_pass_history_index
    // is undefined (SubagentStop hook did not fire for this gate), the
    // precondition fails and the reconciler falls back to legacy behavior
    // (seed-or-skip). This is intentional safe-default degradation.
    if (
      !manifestConverged &&
      sessionCount === 0 &&
      Array.isArray(session.history) &&
      session.history.length >= RECENT_PASS_WINDOW_SIZE
    ) {
      const idx = gateState.last_pass_history_index;
      const floor = Math.max(0, session.history.length - RECENT_PASS_WINDOW_SIZE);
      if (
        typeof idx === 'number' &&
        idx >= floor &&
        idx < session.history.length
      ) {
        const entry = session.history[idx];
        if (entry && entry.event_type === 'convergence_pass_recorded') {
          const details = entry.details || {};
          if (details.gate_name === gate) {
            const prefix = dryRun ? '[dry-run] ' : '';
            const message = `recent pass evidence -- manifest lag for gate '${gate}'`;
            process.stderr.write(
              `${prefix}[session-checkpoint] ${message} ` +
              `(manifest.${convergedKey}=false, session.convergence.${gate}.clean_pass_count=${sessionCount}, ` +
              `last_pass_history_index=${idx}, spec_group='${specGroupId}'). Preserving counter.\n`
            );
            if (!dryRun) {
              addHistoryEntry(session, 'convergence_recent_pass_preserved', {
                gate,
                spec_group_id: specGroupId,
                last_pass_history_index: idx,
                prior_session_count: sessionCount,
                context,
                message,
              });
            }
            continue;
          }
        }
      }
    }

    // Non-converged manifest (not covered by EC-14 preservation) ⇒ skip.
    if (!manifestConverged) {
      continue;
    }

    // as-007 / REQ-012 / AC7.1: derive seed threshold from the per-gate
    // SessionThresholdSnapshot (captured at start-work by as-005). AC7.4
    // graceful degradation: absent snapshot → fall back to the legacy
    // hardcoded default (`CONVERGENCE_SEED_THRESHOLD`). Preserves invariant
    // (a) (session ↔ manifest reconcile correctness): the seed target moves
    // from a module-level constant to a snapshot-anchored value of equal or
    // greater precision. Reader is shared with the hook-enforcement pair
    // (as-008 consumers 3-4) via lib/snapshot-threshold-reader.mjs.
    const seedTarget = readThresholdFromSnapshot(
      session,
      gate,
      CONVERGENCE_SEED_THRESHOLD
    );

    // AC-3.1 / AC-44.1: upward-only. Counter already at or above threshold ⇒ no seed.
    if (sessionCount >= seedTarget) {
      continue;
    }

    // Drift detected: manifest says converged but session count below threshold.
    // Emit grep-stable WARN (AC-37.1), dry-run prefix when applicable (AC-43.1).
    const prefix = dryRun ? '[dry-run] ' : '';
    const warnLine =
      `${prefix}[session-checkpoint] WARN: convergence drift detected on ${context} for gate='${gate}' ` +
      `(manifest.${convergedKey}=true, session.convergence.${gate}.clean_pass_count=${sessionCount}) ` +
      `-- seeding session clean_pass_count=${seedTarget} (manifest wins). ` +
      `See .claude/docs/WORKFLOW-ENFORCEMENT.md#two-store-convergence-model.`;
    console.error(warnLine);

    events.push({
      gate,
      manifest_converged: true,
      prior_session_count: sessionCount,
      seeded_to: seedTarget,
      record_source: 'manifest_seed',
      observed_count: sessionCount,
      seeded_count: seedTarget,
    });

    // Dry-run inspection: no session mutation. Event still emitted for caller
    // (history append is suppressed by caller when opts.dryRun === true).
    if (dryRun) {
      continue;
    }

    // Mutate session: ensure the convergence/gate/sources[] structure exists,
    // then seed the count and append the manifest_seed provenance event.
    if (!session.convergence) session.convergence = {};
    if (!session.convergence[gate]) session.convergence[gate] = {};
    if (!Array.isArray(session.convergence[gate].sources)) {
      session.convergence[gate].sources = [];
    }
    session.convergence[gate].clean_pass_count = seedTarget;
    session.convergence[gate].sources.push({
      record_source: 'manifest_seed',
      parse_failed: false,
      parse_failed_reason: null,
      timestamp: now(),
      context,
      prior_session_count: sessionCount,
      spec_group_id: specGroupId,
    });
  }

  return events;
}

/**
 * Apply a --force-reset-convergence operation for all gates that the
 * manifest currently marks converged. Sets session.clean_pass_count=0 and
 * manifest.<gate>_converged=false, appends an audit entry to
 * manifest.decision_log[], and records a matching session-side sources[]
 * entry with record_source: "force_reset" for symmetry with manifest_seed.
 *
 * Mutates both session AND manifest objects in memory. Caller is
 * responsible for persisting.
 *
 * Idempotent: re-running with no converged gates is a no-op.
 */
function applyForceResetConvergence(session, manifest, opts = {}) {
  if (!manifest || typeof manifest !== 'object') {
    return { reset_gates: [] };
  }
  if (!manifest.convergence) {
    return { reset_gates: [] };
  }
  if (!Array.isArray(manifest.decision_log)) {
    manifest.decision_log = [];
  }
  const resetGates = [];
  for (const gate of VALID_CONVERGENCE_GATES) {
    const convergedKey = `${gate}_converged`;
    const wasConverged = manifest.convergence[convergedKey] === true;
    const sessionCount = session.convergence?.[gate]?.clean_pass_count ?? 0;
    // Reset even if only one side disagrees, per AC-001.3 ("SHALL be set to ...").
    if (!wasConverged && sessionCount === 0) {
      continue;
    }
    manifest.convergence[convergedKey] = false;
    if (!session.convergence) session.convergence = {};
    if (!session.convergence[gate]) session.convergence[gate] = {};
    if (!Array.isArray(session.convergence[gate].sources)) {
      session.convergence[gate].sources = [];
    }
    session.convergence[gate].clean_pass_count = 0;
    session.convergence[gate].sources.push({
      record_source: 'force_reset',
      parse_failed: false,
      parse_failed_reason: null,
      timestamp: now(),
      context: opts.context || 'start-work',
      prior_manifest_converged: wasConverged,
      prior_session_count: sessionCount,
    });
    resetGates.push({ gate, prior_manifest_converged: wasConverged, prior_session_count: sessionCount });
  }
  if (resetGates.length > 0) {
    manifest.decision_log.push({
      timestamp: now(),
      actor: opts.actor || 'operator',
      action: 'convergence_force_reset',
      details: `Operator invoked start-work --force-reset-convergence; reset ${resetGates.length} gate(s): ${resetGates.map(r => r.gate).join(', ')}`,
      reset_gates: resetGates,
    });
  }
  return { reset_gates: resetGates };
}

// =============================================================================
// Operations
// =============================================================================

/**
 * init - Initialize session.json if it doesn't exist.
 */
function opInit() {
  ensureContextDir();

  if (existsSync(SESSION_PATH)) {
    const session = loadSession();
    if (session) {
      console.error('session.json already exists and is valid.');
      return;
    }
    // File exists but is invalid - recreate
    console.error('session.json exists but is invalid. Recreating...');
  }

  const session = createEmptySession();
  addHistoryEntry(session, 'session_start', {
    message: 'Session initialized'
  });
  saveSession(session);
  console.error(`Initialized session.json at ${SESSION_PATH}`);
}

/**
 * start-work - Start tracking work on a spec group.
 *
 * Two invocation forms (sg-enforcement-layer-gaps Task 19 / chk-contract-a1f3b902):
 *   1. Positional (legacy, backward-compat per AC-8.8):
 *        start-work <spec_group_id> <workflow> <objective>
 *   2. Flag-only (for exempt workflows; AC-8.1, AC-8.9):
 *        start-work --exempt-workflow <W>
 *      where W ∈ EXEMPT_WORKFLOWS. Auto-generates spec_group_id = "vibe-<ISO>"
 *      and objective = user prompt first line (from CLAUDE_USER_PROMPT env var)
 *      or "ad-hoc vibe-mode task" fallback.
 *
 * Mutual exclusion: positional args + --exempt-workflow cannot mix.
 *
 * Inherit semantics (AC-10.3): for the flag-only form, if active_work.workflow
 * already equals W AND W ∈ EXEMPT_WORKFLOWS, returns early with status
 * "already-active" and audit entry — no mutation. Positional form retains
 * the existing throw on pre-existing active_work.
 *
 * workflow_set_by: the flag-only form implicitly sets "route-skill" (the only
 * route-skill-authored entry path). Positional form retains legacy behavior
 * (workflow_set_by not recorded unless a future writer sets it).
 *
 * Downgrade protection (AC-10.1): workflow downgrades (e.g., orchestrator →
 * oneoff-vibe) require --override-workflow and retain the throw. The
 * --override-workflow flag is mutually exclusive with --exempt-workflow for
 * the flag-only form — downgrade from the exempt-workflow surface requires
 * complete-work first (EC-21).
 */
function opStartWork(args) {
  // Parse flags vs positional. Two forms supported.
  // Args is passed as-is from argv[2..]; the caller (main()) passes
  // args.slice(1) of the original argv.
  const argList = Array.isArray(args) ? args : [args];

  // Detect flag-only form: --exempt-workflow <W>.
  let exemptWorkflowFlag = null;
  let overrideWorkflow = false;
  // Explicit escape hatch for operator-initiated convergence reset.
  // Default (flag absent) applies
  // the manifest-seed reconciliation from as-008.
  let forceResetConvergence = false;
  // Operator-supplied flag permitting start-work to auto-clear a dangling
  // active_work pointer (spec-group directory no longer exists). Without
  // the flag, the existing active-work-collision throw is preserved.
  let clearDangling = false;
  // ws-dag-substages / AC-C7 / NFR-21: probe-form flags used exclusively to
  // detect mid-session workflow-downgrade attempts. When both --workflow=<W>
  // and --spec-group=<id> are supplied with no positional/objective tail,
  // this is a WORKFLOW_IMMUTABLE probe — reject before the positional-form
  // "Usage" throw so callers observe the R-021 error code.
  let probeWorkflowFlag = null;
  let probeSpecGroupFlag = null;
  const positional = [];
  for (let i = 0; i < argList.length; i++) {
    const a = argList[i];
    if (a === '--exempt-workflow' && i + 1 < argList.length) {
      exemptWorkflowFlag = argList[i + 1];
      i++;
    } else if (a === '--override-workflow') {
      overrideWorkflow = true;
    } else if (a === '--force-reset-convergence') {
      forceResetConvergence = true;
    } else if (a === '--clear-dangling') {
      clearDangling = true;
    } else if (a.startsWith('--workflow=')) {
      probeWorkflowFlag = a.slice('--workflow='.length);
    } else if (a.startsWith('--spec-group=')) {
      probeSpecGroupFlag = a.slice('--spec-group='.length);
    } else {
      positional.push(a);
    }
  }

  const isFlagOnlyForm = exemptWorkflowFlag !== null;

  // ws-dag-substages / AC-C7 / NFR-21: early WORKFLOW_IMMUTABLE probe. If
  // both --workflow and --spec-group flags are present AND an active session
  // is loaded with a conflicting workflow AND that workflow is non-exempt,
  // reject with WORKFLOW_IMMUTABLE error code WITHOUT mutating session state
  // (R-021). Runs BEFORE the positional-form Usage throw because the test
  // contract requires callers using these flags to observe the error code
  // rather than a generic usage message.
  if (probeWorkflowFlag !== null && probeSpecGroupFlag !== null && !isFlagOnlyForm && positional.length === 0) {
    const probeSession = loadSession();
    if (probeSession && probeSession.active_work) {
      const currentWf = probeSession.active_work.workflow;
      if (
        currentWf &&
        currentWf !== probeWorkflowFlag &&
        !EXEMPT_WORKFLOWS.includes(currentWf)
      ) {
        // Emit structured log line for audit trail (spec-contracted shape).
        try {
          process.stderr.write(
            JSON.stringify({
              event: WORKFLOW_IMMUTABLE_ERROR_CODE,
              current: currentWf,
              requested: probeWorkflowFlag,
              session_id: hashSessionIdForAdmittedLog(probeSession?.session_id),
            }) + '\n'
          );
        } catch {
          // Silent on log-emission failure.
        }
        console.error(
          `${WORKFLOW_IMMUTABLE_ERROR_CODE}: cannot change workflow mid-session ` +
            `(current: ${currentWf}, requested: ${probeWorkflowFlag}). ` +
            `Run complete-work or archive-incomplete first, or re-invoke with --override-workflow.`
        );
        process.exit(1);
      }
    }
  }

  // Form routing.
  let specGroupId;
  let workflow;
  let objective;
  let workflowSetBy;

  if (isFlagOnlyForm) {
    // Flag-only form (AC-8.1, AC-8.9, AC-10.3a).
    if (positional.length > 0) {
      throw new Error(
        '--exempt-workflow is mutually exclusive with positional args. ' +
          'Usage: start-work --exempt-workflow <workflow>'
      );
    }
    if (overrideWorkflow) {
      throw new Error(
        '--override-workflow is not permitted with --exempt-workflow. Use complete-work to end the current work first.'
      );
    }
    workflow = exemptWorkflowFlag;
    if (!EXEMPT_WORKFLOWS.includes(workflow)) {
      throw new Error(
        `--exempt-workflow requires one of [${EXEMPT_WORKFLOWS.join(', ')}], got '${workflow}'`
      );
    }
    // AC-8.9: auto-generate spec_group_id = "vibe-<ISO>" and objective
    // from CLAUDE_USER_PROMPT env var (first line, 120 chars) or fallback.
    specGroupId = `vibe-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const userPrompt = (process.env.CLAUDE_USER_PROMPT || '').split('\n')[0].trim();
    objective = userPrompt.length > 0
      ? userPrompt.slice(0, 120)
      : 'ad-hoc vibe-mode task';
    workflowSetBy = 'route-skill';
  } else {
    // Positional form (legacy, AC-8.8 backward-compat).
    if (positional.length < 3) {
      throw new Error('Usage: start-work <spec_group_id> <workflow> <objective>');
    }
    specGroupId = positional[0];
    workflow = positional[1];
    objective = positional.slice(2).join(' ');
    validateSpecGroupId(specGroupId);
    // workflowSetBy is not set for positional form — backward-compat.
  }

  validateWorkflow(workflow);

  // Dual-corrupt fail-closed guard. Must run BEFORE loadSession() because
  // loadSession swallows parse errors as null, which is indistinguishable
  // from a missing file. EC-15 demands we distinguish corrupt-both from
  // fresh-start-both.
  //
  // Scope (per spec EC-15): apply only in the positional form where a
  // spec_group_id is available for manifestPath resolution. The flag-only
  // vibe form synthesizes a spec_group_id so manifestPath lookup is
  // meaningless (no corresponding manifest exists).
  if (!isFlagOnlyForm) {
    const mPath = manifestPathFor(specGroupId);
    const sRaw = tryReadJson(SESSION_PATH);
    const mRaw = tryReadJson(mPath);

    const sessionCorrupt = !sRaw.ok && !sRaw.absent; // present but unparseable
    const manifestCorrupt = !mRaw.ok && !mRaw.absent;

    if (sessionCorrupt && manifestCorrupt) {
      // AC1.3: optional audit (no-op if audit-append.mjs is absent -- Phase C)
      const auditResult = tryEmitDualCorruptAudit({
        rationale: `start-work on '${specGroupId}': both stores unreadable`,
      });
      // AC1.1 + AC1.2: fail-closed; do NOT auto-rebuild either file.
      console.error(`[session-checkpoint] ${E_DUAL_CORRUPT_MESSAGE}`);
      console.error(
        `[session-checkpoint] session.json parse error: ${sRaw.error?.message || 'unknown'}`
      );
      console.error(
        `[session-checkpoint] manifest.json parse error: ${mRaw.error?.message || 'unknown'}`
      );
      if (!auditResult.invoked) {
        console.error(
          `[session-checkpoint] dual_corrupt audit NOT emitted: ${auditResult.reason}`
        );
      }
      throw new Error(E_DUAL_CORRUPT_MESSAGE);
    }
  }

  let session = loadSession();
  if (!session) {
    session = createEmptySession();
  }
  let clearedDanglingActiveWork = false;

  // --clear-dangling handling. Must run BEFORE the active-work collision
  // check so operators can unblock themselves after a spec group deletion.
  if (clearDangling) {
    const priorActiveWork = session.active_work;
    const priorSpecGroupId = priorActiveWork?.spec_group_id;
    let isDangling = false;
    if (priorSpecGroupId) {
      const priorSpecDir = join(CLAUDE_DIR, 'specs', 'groups', priorSpecGroupId);
      isDangling = !existsSync(priorSpecDir);
    }
    if (isDangling) {
      // AC-19.1: clear the dangling pointer and proceed with start-work.
      session.active_work = null;
      session.phase_checkpoint = null;
      clearedDanglingActiveWork = true;
      addHistoryEntry(session, 'dangling_active_work_cleared', {
        prior_spec_group_id: priorSpecGroupId,
        message: `Operator invoked --clear-dangling; cleared dangling active_work pointer to '${priorSpecGroupId}' (directory missing).`,
      });
      console.error(
        `[session-checkpoint] --clear-dangling: cleared dangling active_work pointer to '${priorSpecGroupId}'`
      );
      // Fall through to the normal start-work path below.
    } else {
      // AC-20.1: no dangling pointer. Emit stderr + exit 0 + no history entry.
      process.stderr.write('no dangling active_work pointer to clear\n');
      return;
    }
  }

  // --- Active-work collision handling ---
  if (session.active_work) {
    const currentWorkflow = session.active_work.workflow;

    if (isFlagOnlyForm) {
      // AC-10.3 (flag-only): exempt-workflow inherit — if already same exempt
      // workflow, return early with audit entry, no mutation.
      if (
        currentWorkflow === workflow &&
        EXEMPT_WORKFLOWS.includes(currentWorkflow)
      ) {
        addHistoryEntry(session, 'work_started_already_active', {
          spec_group_id: session.active_work.spec_group_id,
          workflow: currentWorkflow,
          workflow_set_by: workflowSetBy,
          status: 'already-active',
          message: `start-work --exempt-workflow ${workflow}: already-active (inherit path)`,
        });
        saveSession(session);
        console.error(
          `start-work --exempt-workflow ${workflow}: already-active (no mutation)`
        );
        return;
      }
      // AC-10.1 downgrade protection: non-matching workflow rejects unless
      // override. Flag-only form prohibits --override-workflow (handled above),
      // so this always rejects for non-matching workflows.
      // NFR-21 / AC-C7: emit structured WORKFLOW_IMMUTABLE log BEFORE throwing
      // so the audit trail captures the attempt. Exempt current workflows
      // bypass per AC4.5.
      if (currentWorkflow && currentWorkflow !== workflow && !EXEMPT_WORKFLOWS.includes(currentWorkflow)) {
        try {
          process.stderr.write(JSON.stringify({
            event: WORKFLOW_IMMUTABLE_ERROR_CODE,
            current: currentWorkflow,
            requested: workflow,
            session_id: hashSessionIdForAdmittedLog(session?.session_id),
          }) + '\n');
        } catch {
          // Never throw from log emission.
        }
      }
      throw new Error(
        `${WORKFLOW_IMMUTABLE_ERROR_CODE}: Active work already exists for '${session.active_work.spec_group_id}' (workflow: ${currentWorkflow}). ` +
          `Cannot downgrade to '${workflow}'. Run complete-work or archive-incomplete first.`
      );
    }

    // Positional form: AC-8.8 backward-compat — retain the throw. Honor
    // --override-workflow only for workflow downgrades.
    if (overrideWorkflow) {
      // Operator override: record in history and overwrite. This is the
      // canonical downgrade path (AC-10.1 escape hatch).
      addHistoryEntry(session, 'workflow_overridden', {
        prior_workflow: currentWorkflow,
        new_workflow: workflow,
        spec_group_id: session.active_work.spec_group_id,
        override: true,
        message: `Operator overrode workflow ${currentWorkflow} -> ${workflow}`,
      });
      // Fall through to the re-init path. workflow_set_by records the path.
      workflowSetBy = 'operator-override';
    } else {
      // NFR-21 / AC-C7: when requested workflow differs from current (no
      // override), emit WORKFLOW_IMMUTABLE structured log and throw. Exempt
      // current workflows bypass per AC4.5.
      if (currentWorkflow && currentWorkflow !== workflow && !EXEMPT_WORKFLOWS.includes(currentWorkflow)) {
        try {
          process.stderr.write(JSON.stringify({
            event: WORKFLOW_IMMUTABLE_ERROR_CODE,
            current: currentWorkflow,
            requested: workflow,
            session_id: hashSessionIdForAdmittedLog(session?.session_id),
          }) + '\n');
        } catch {
          // Never throw from log emission.
        }
        throw new Error(
          `${WORKFLOW_IMMUTABLE_ERROR_CODE}: cannot change workflow mid-session ` +
          `(current: ${currentWorkflow}, requested: ${workflow}). ` +
          `Run complete-work or archive-incomplete first, or re-invoke with --override-workflow.`
        );
      }
      throw new Error(
        `Active work already exists for '${session.active_work.spec_group_id}'. ` +
          `Use 'complete-work' or 'archive-incomplete' first.`
      );
    }
  }

  // Determine initial phase based on workflow
  let initialPhase;
  switch (workflow) {
    case 'oneoff-vibe':
      initialPhase = 'implementing';
      break;
    case 'oneoff-spec':
    case 'orchestrator':
      initialPhase = 'prd_gathering';
      break;
    case 'refactor':
      initialPhase = 'spec_authoring';
      break;
    case 'journal-only':
      initialPhase = 'journaling';
      break;
    default:
      initialPhase = 'prd_gathering';
  }

  session.active_work = {
    spec_group_id: specGroupId,
    workflow,
    current_phase: initialPhase,
    objective,
  };

  // AC-10.2: record workflow_set_by for route-skill and operator-override paths.
  if (workflowSetBy) {
    session.active_work.workflow_set_by = workflowSetBy;
  }

  // sg-pipeline-efficiency-ws1-convergence-pruning / as-005 (REQ-012) + as-006 (REQ-014)
  // SessionThresholdSnapshot capture (AC5.1, AC5.2, AC5.3) with genesis-anchor
  // verification woven in advisory mode (AC6.1..AC6.4).
  //
  // Capture the immutable per-gate threshold snapshot BEFORE saveSession() so
  // the first persistence hop already carries the snapshot, and downstream
  // consumers invoked later in the same session cannot observe an
  // active_work without a snapshot. Only the positional (spec-group) form
  // captures a snapshot; the flag-only vibe form synthesises a spec_group_id
  // and is exempt from the pipeline-efficiency convergence gates, so
  // snapshot capture is not required.
  //
  // Absence of the enforcement-flag file (as-015 owns creation) falls back
  // to `source: "hardcoded-default"` per AC5.2. If the flag is present and
  // well-formed, `source` reflects the mode.
  //
  // Genesis-anchor verification (as-006 / REQ-014 / EC-13): invoked inside
  // buildSessionThresholdSnapshot() via verifyGenesisAnchor(). Advisory per
  // AC6.4 — a GENESIS_ANCHOR_INVALID or CHAIN_BROKEN result NEVER blocks
  // start-work; it forces `source: "hardcoded-default"` and sets every
  // per_gate[g].required_clean_passes to 2 regardless of the seeded
  // PerGateThresholdTable values. Until as-018 lands the full
  // `verify-audit-chain.mjs`, the helper falls back to an in-process stub
  // that validates the genesis file shape against the REQ-014 contract.
  if (!isFlagOnlyForm) {
    try {
      const snapshot = buildSessionThresholdSnapshot({
        claudeDir: CLAUDE_DIR,
        sessionStartedAt: new Date().toISOString(),
      });
      session.active_work.threshold_snapshot = snapshot;
    } catch (err) {
      // Fail-closed: an unbuilt snapshot would leave downstream consumers
      // with nothing to read. Propagate the error so start-work aborts
      // rather than persisting a session in an inconsistent state.
      //
      // Note: genesis-verification failures do NOT reach this branch —
      // verifyGenesisAnchor() never throws (AC6.4). Only schema-validation
      // or table-integrity errors propagate here.
      throw new Error(
        `SNAPSHOT_CAPTURE_FAILED: could not build SessionThresholdSnapshot at start-work: ${err.message}`
      );
    }
  }

  session.phase_checkpoint = {
    phase: initialPhase,
    atomic_specs_completed: [],
    atomic_specs_pending: [],
    next_actions: [],
    // Enforcement fields (REQ-005) -- backward-compatible defaults
    phase_skip_warnings: {},
    enforcement_counter: 0,
    _counter_checksum: computeCounterChecksum(0),
    enforcement_level: 'graduated',
    override_count: 0
  };

  // Initialize journal tracking fields for journal-only workflow
  if (workflow === 'journal-only') {
    session.phase_checkpoint.journal_required = true;
    session.phase_checkpoint.journal_created = false;
    session.phase_checkpoint.journal_entry_path = null;
  }

  addHistoryEntry(session, 'work_started', {
    spec_group_id: specGroupId,
    workflow,
    workflow_set_by: workflowSetBy || null,
    message: `Started work: ${objective}`
  });

  // AC-12.5 audit alarm: detect stale-completion pattern. If `history[]`
  // shows a recent work_completed event whose spec_group_id matches the
  // new start-work's target, emit a high-severity warning to history[].
  // Note: this is informational only; start-work still proceeds.
  const recentCompletions = (session.history || [])
    .filter(h => h.event_type === 'work_completed')
    .slice(-10)
    .reverse();
  if (recentCompletions.length > 0) {
    const lastCompletion = recentCompletions[0];
    if (lastCompletion?.details?.spec_group_id === specGroupId) {
      addHistoryEntry(session, 'start_work_after_completion_audit', {
        spec_group_id: specGroupId,
        prior_completion_ts: lastCompletion.timestamp,
        severity: 'high',
        message:
          'start-work on a spec_group with a recent work_completed history entry. ' +
          'Operator review suggested to confirm this is a legitimate re-open.',
      });
    }
  }

  // Generate session.session_id BEFORE the manifest-read-and-reconcile block
  // so the force-reset branch (which writes force_reset_reconcile_skip[<sg>].
  // session_id) always has a valid session identity. Previously generated
  // after the reconcile block at `:1096-1098`; moved earlier to eliminate
  // ordering hazard for fresh sessions undergoing --force-reset-convergence
  // on their first start-work.
  if (!session.session_id) {
    // sec-trust-a1b2c3d4: crypto.randomUUID() gives cryptographically strong
    // uniqueness vs Math.random()+timestamp+pid which can collide across
    // parallel sessions started in the same millisecond on the same PID.
    session.session_id = randomUUID();
  }

  // Cross-store convergence reconciliation. Applied only for the positional
  // form; the flag-only vibe form synthesizes a spec_group_id without a
  // corresponding manifest.
  if (!isFlagOnlyForm) {
    const mPath = manifestPathFor(specGroupId);
    const mRaw = tryReadJson(mPath);
    if (mRaw.ok && mRaw.value) {
      const manifest = mRaw.value;

      if (forceResetConvergence) {
        // as-009 / AC-001.3: explicit operator reset -- rewrite manifest AND session.
        const { reset_gates } = applyForceResetConvergence(session, manifest, {
          context: 'start-work',
          actor: 'operator',
        });
        if (reset_gates.length > 0) {
          try {
            writeFileSync(
              mPath,
              JSON.stringify(manifest, null, 2) + '\n'
            );
          } catch (err) {
            console.error(
              `[session-checkpoint] WARN: failed to persist force-reset manifest update: ${err.message}`
            );
          }
          addHistoryEntry(session, 'convergence_force_reset', {
            spec_group_id: specGroupId,
            reset_gates: reset_gates.map(r => r.gate),
            message: `Operator invoked --force-reset-convergence; reset ${reset_gates.length} gate(s)`,
          });
          console.error(
            `[session-checkpoint] --force-reset-convergence: reset ${reset_gates.length} gate(s): ${reset_gates.map(r => r.gate).join(', ')}`
          );
        } else {
          console.error(
            `[session-checkpoint] --force-reset-convergence: no-op (no gates currently converged)`
          );
        }
        // record regardless of reset_gates.length, so any subsequent reconcile
        // in the same session short-circuits even when the force-reset was a
        // no-op from a gate-count perspective (operator signalled intent to
        // skip reconciliation).
        // Defensive fail-closed guard (chk-ordering-9d3c2e78): throw if
        // session.session_id is falsy at this point -- should be unreachable
        // given the earlier unconditional generation, but guards against
        // future refactors that might move the generation block again.
        if (!session.session_id) {
          throw new Error(
            'T-05 invariant violation: session.session_id is falsy at force_reset_reconcile_skip write time. ' +
            'This indicates a session_id ordering regression; see chk-ordering-9d3c2e78.'
          );
        }
        if (!session.force_reset_reconcile_skip || typeof session.force_reset_reconcile_skip !== 'object') {
          session.force_reset_reconcile_skip = {};
        }
        session.force_reset_reconcile_skip[specGroupId] = {
          session_id: session.session_id,
          sequence: Array.isArray(session.history) ? session.history.length : 0,
        };
      } else {
        // as-008 / AC-001.1 + AC-007.2: default manifest-seed reconciliation.
        // Thread spec_group_id through opts for force-reset precedence scoping.
        const events = reconcileConvergenceFromManifest(session, manifest, {
          context: 'start-work',
          spec_group_id: specGroupId,
        });
        if (events.length > 0) {
          addHistoryEntry(session, 'convergence_manifest_seeded', {
            spec_group_id: specGroupId,
            events,
            message: `Seeded ${events.length} gate(s) from manifest: ${events.map(e => e.gate).join(', ')}`,
            context: 'start-work',
          });
        }
      }
    } else if (forceResetConvergence && !mRaw.ok) {
      // Flag set but no manifest to reset: session-only reset for symmetry.
      console.error(
        `[session-checkpoint] --force-reset-convergence: manifest not present; resetting session counters only`
      );
      if (session.convergence && typeof session.convergence === 'object') {
        for (const gate of VALID_CONVERGENCE_GATES) {
          if (session.convergence[gate]?.clean_pass_count > 0) {
            session.convergence[gate].clean_pass_count = 0;
          }
        }
      }
      // record the skip intent so subsequent reconcile attempts in this
      // session short-circuit. Same fail-closed defensive check.
      if (!session.session_id) {
        throw new Error(
          'T-05 invariant violation: session.session_id is falsy at force_reset_reconcile_skip write time (manifest-absent branch).'
        );
      }
      if (!session.force_reset_reconcile_skip || typeof session.force_reset_reconcile_skip !== 'object') {
        session.force_reset_reconcile_skip = {};
      }
      session.force_reset_reconcile_skip[specGroupId] = {
        session_id: session.session_id,
        sequence: Array.isArray(session.history) ? session.history.length : 0,
      };
    }
  }

  // Register AFTER the active_work assignment so the session carries an identity the orphan
  // scan can snapshot against itself. session_id is generated above
  // (T-05: moved earlier for force-reset-convergence ordering safety).
  try {
    registerActiveSession(session, {
      session_id: session.session_id,
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
    });
    // Snapshot BEFORE prune so own entry is always in the live set.
    const liveIds = snapshotLiveSessionIds(session);
    pruneDeadSessions(session);
    // Advisory-only orphan scan against coordination/ — do NOT delete; we only
    // log. Actual clearing of other-session sentinels happens implicitly via
    // the session-scoped reader contract (lib/sentinel.mjs).
    const coordinationDir = join(CLAUDE_DIR, 'coordination');
    const orphans = findOrphanSentinels(coordinationDir, liveIds);
    if (orphans.length > 0) {
      addHistoryEntry(session, 'active_sessions_orphan_scan', {
        live_session_count: liveIds.size,
        orphan_paths: orphans.map(o => o.path),
        message: `Orphan scan found ${orphans.length} non-live sentinel(s); left in place for reader-side ignore`,
      });
    }
  } catch (err) {
    // Fail-open: registry is advisory; do not block start-work.
    console.error(`[session-checkpoint] WARN: active-sessions registry step failed: ${err.message}`);
  }

  // sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-006 (REQ-007 / AC6.1, AC6.2)
  // Worktree pin capture. Persist canonicalized `CLAUDE_PROJECT_DIR` to
  // `session.active_work.project_dir_pin` so downstream consumers
  // (as-007..as-010 hook wiring) can enforce env-parity / escape-guard
  // against a stable pin that cannot be tampered with mid-session.
  //
  // AC6.1: capturePin(CLAUDE_PROJECT_DIR) realpath-resolves and rejects
  //        symlink components; autoDetectCaseFS() probes once and caches
  //        into `case_insensitive_fs`.
  // AC6.2: immutability — if `project_dir_pin` is already set (e.g., this
  //        start-work was invoked on an already-pinned session via
  //        --override-workflow), do NOT mutate. Legitimate re-pinning uses
  //        the `rotate-worktree` action (AC6.3).
  //
  // Pin capture runs for BOTH positional and flag-only forms — worktree-canon
  // enforcement applies uniformly regardless of workflow (vibe sessions
  // still receive file writes that must be escape-guarded against the pin).
  //
  // Fail-closed: a `WORKTREE_PATH_VIOLATION` from capturePin() (e.g., symlink
  // in `CLAUDE_PROJECT_DIR` itself) aborts start-work BEFORE saveSession()
  // so the session never persists with an invalid pin.
  if (!session.active_work.project_dir_pin) {
    const envRoot = process.env.CLAUDE_PROJECT_DIR;
    if (envRoot) {
      // capturePin throws WORKTREE_PATH_VIOLATION on symlink-component or
      // realpath failure; propagate so operator sees the canonical error.
      session.active_work.project_dir_pin = capturePin(envRoot);
      // Probe case-sensitivity once per session; result cached for the
      // lifetime of the active_work record.
      session.active_work.case_insensitive_fs = autoDetectCaseFS();
    }
    // If CLAUDE_PROJECT_DIR is not set (unusual in hook/agent contexts),
    // the pin remains absent. Consumers (as-007..as-010) gracefully no-op
    // on absent pin — enforcement is opt-in via presence.
  }

  // sg-pipeline-efficiency-ws1-convergence-pruning / as-027 / AC27.1 (Task I1)
  // Snapshot-before-save invariant. For the positional (non-vibe) form the
  // SessionThresholdSnapshot must have been captured by the block at L1586-1605
  // BEFORE the first saveSession() persists `session.active_work` to disk.
  // Any consumer (threshold-reader superset) that later reads
  // session.json will therefore observe `active_work` AND `threshold_snapshot`
  // atomically — the pair cannot appear to consumers in a torn state where
  // `active_work` exists without its snapshot.
  //
  // This is a defensive guard against future refactors that might reorder
  // the snapshot-capture block relative to saveSession(). A structural
  // regression would be caught here at start-work time rather than surfacing
  // later as a phantom "snapshot absent" fallback at a downstream consumer.
  if (!isFlagOnlyForm) {
    const snap = session.active_work && session.active_work.threshold_snapshot;
    if (!snap || typeof snap !== 'object' || !snap.per_gate) {
      throw new Error(
        'SNAPSHOT_ORDERING_VIOLATION: session.active_work.threshold_snapshot ' +
          'must be populated before saveSession() on the positional start-work ' +
          'path (as-027 / AC27.1 / Task I1). ' +
          'If this fires, the snapshot-capture block was skipped or reordered ' +
          'relative to the persistence hop — audit L1586-1605 vs L1810.'
      );
    }
  }

  saveSession(session, {
    allowSnapshotLifecycleReset: clearedDanglingActiveWork,
  });
  console.error(`Started work on '${specGroupId}' with workflow '${workflow}'`);
}

/**
 * sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-006 (REQ-007 / AC6.3)
 *
 * rotate-worktree <new-root>
 *
 * Facilitator-only re-pin path for legitimate worktree rotations (e.g., when
 * the facilitator swaps one worktree for another mid-session). Atomically
 * updates `session.active_work.project_dir_pin` after canonicalizing
 * `<new-root>`. Appends an audit-log entry with `event_class` equal to the
 * canonical `worktree_path_violation` class (ws-3 shares that class for all
 * pin-lifecycle events per spec §Implementation Notes) so the re-pin is
 * observable in the hash-chained audit log.
 *
 * CLI form:
 *   rotate-worktree <new-root>
 *
 * Preconditions:
 *   - An active_work record MUST exist. Without a prior pin there is nothing
 *     to rotate; operators should invoke `start-work` instead.
 *
 * Canonicalization model (AC6.3 / CVG-001 fix):
 *   - `<new-root>` is realpath-resolved BEFORE `capturePin()`. The facilitator
 *     is a trusted actor invoking a legitimate rotation and is permitted to
 *     reference canonical well-known directories via their conventional
 *     symlinks (e.g., `/tmp → /private/tmp` on Darwin, per AC6.3 integration
 *     test). `start-work` retains the stricter symlink-reject contract for
 *     `CLAUDE_PROJECT_DIR` — operator-controlled input where a symlink may
 *     signal an escape attempt — but rotate-worktree operates on a
 *     facilitator-provided path that is resolved before downstream pin-shape
 *     validation. `capturePin()` still runs on the realpath-resolved target
 *     to enforce pin-shape invariants (absolute, non-empty, realpath-stable).
 *
 * Error behavior:
 *   - `<new-root>` absent -> usage error (exit 1).
 *   - No active_work -> error (exit 1).
 *   - `realpathSync.native(<new-root>)` throws ENOENT when the target does
 *     not exist; surfaced as a structured Error (exit 1 via main catch).
 *   - `capturePin(<realpath>)` throws WORKTREE_PATH_VIOLATION if the
 *     realpath-resolved target still contains a symlink component
 *     (pathological hosts with nested symlink chains); propagated (exit 1).
 *
 * @param {string} newRoot - Path to the new worktree root (symlinks resolved).
 */
function opRotateWorktree(newRoot) {
  if (!newRoot || typeof newRoot !== 'string') {
    throw new Error('Usage: rotate-worktree <new-root>');
  }

  const session = loadSession();
  if (!session || !session.active_work) {
    throw new Error(
      'rotate-worktree requires an active work session. Run start-work first.'
    );
  }

  // AC6.3 (CVG-001): rotate-worktree is a facilitator-trusted re-pin entry.
  // Resolve symlinks FIRST so well-known canonical directories (e.g.,
  // `/tmp → /private/tmp` on Darwin) succeed. `capturePin()` then runs on
  // the realpath-resolved target to enforce the pin-shape contract. This
  // diverges from start-work (which rejects any symlinked CLAUDE_PROJECT_DIR)
  // because start-work consumes operator-controlled env while rotate-worktree
  // consumes a facilitator-supplied argument — the threat models differ.
  const priorPin = session.active_work.project_dir_pin || null;
  let realRoot;
  try {
    realRoot = realpathSync.native(newRoot);
  } catch (err) {
    const code = err && err.code;
    throw new Error(
      `rotate-worktree: cannot canonicalize new-root ${newRoot}: ${code || err.message}`
    );
  }
  const canonicalizedNewPin = capturePin(realRoot);

  // Atomic mutation: update both pin + case-FS (the new worktree may live
  // on a different filesystem) before persistence.
  session.active_work.project_dir_pin = canonicalizedNewPin;
  session.active_work.case_insensitive_fs = autoDetectCaseFS();

  // Append audit-log entry BEFORE saveSession() — mirrors the opToggleKillSwitch
  // ordering so an append failure leaves the session unmutated on disk.
  // event_class `worktree_path_violation` is the canonical class for all
  // pin-lifecycle events per spec §Implementation Notes (ws-1 as-003 9-class
  // enum).
  try {
    appendAuditEntry(
      'worktree_path_violation',
      'rotate-worktree',
      {
        prior_pin: priorPin,
        new_pin: canonicalizedNewPin,
        session_id: session.session_id || null,
        spec_group_id: session.active_work.spec_group_id || null,
      },
      { actor: 'operator' }
    );
  } catch (err) {
    // Audit-append failure: abort rotation so session + audit stay consistent.
    throw new Error(
      `rotate-worktree aborted: audit-log append failed: ${err.message}`
    );
  }

  addHistoryEntry(session, 'worktree_rotated', {
    prior_pin: priorPin,
    new_pin: canonicalizedNewPin,
    message: `Facilitator rotated worktree root: ${priorPin || '(absent)'} -> ${canonicalizedNewPin}`,
  });

  saveSession(session);
  console.error(
    `rotate-worktree: pin updated ${priorPin || '(absent)'} -> ${canonicalizedNewPin}`
  );
}

/**
 * Convergence-state manual reconciliation CLI.
 *
 * reconcile-convergence <spec_group_id> [--dry-run] [--exempt-workflow <w>]
 *
 * On-demand cross-store reconciliation helper. Runs the same manifest-seed
 * path as start-work, so completion-verifier and future callers converge on
 * one code path. Emits the same WARN + sources[] entry shape; no side
 * effects unless a drift is actually detected.
 *
 * Flags (T-07 / T-10 / AC-12 / AC-22):
 *   --dry-run                 Read-only drift inspection; stderr prefixed with
 *                             `[dry-run] `; no session.json mutation; exit 0
 *                             regardless of drift.
 *   --exempt-workflow <w>     Advisory-only; bypasses reconciliation uniformly
 *                             when <w> is in EXEMPT_WORKFLOWS. Operates via
 *                             isExemptWorkflow() predicate (AC-22.1).
 */
function opReconcileConvergence(args) {
  // T-07 / T-10 / T-11: arg parsing for --dry-run and --exempt-workflow.
  const argList = Array.isArray(args) ? args : (args ? [args] : []);
  let dryRun = false;
  let exemptWorkflow = null;
  const positional = [];
  for (let i = 0; i < argList.length; i++) {
    const a = argList[i];
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--exempt-workflow' && i + 1 < argList.length) {
      exemptWorkflow = argList[i + 1];
      i++;
    } else {
      positional.push(a);
    }
  }

  const specGroupId = positional[0];
  if (!specGroupId) {
    // AC-16.1 / EC-17: no-arg exits 1 with usage hint (no walk-all).
    process.stderr.write(
      'Usage: reconcile-convergence <spec_group_id> [--dry-run] [--exempt-workflow <w>]\n'
    );
    process.exit(1);
  }
  validateSpecGroupId(specGroupId);

  // T-10 / AC-22.1 / AC-22.2 / AC-48.1: exempt-workflow uniform bypass.
  // When --exempt-workflow is supplied AND the value is in EXEMPT_WORKFLOWS,
  // bypass reconciliation with explanatory stderr and exit 0.
  if (exemptWorkflow && isExemptWorkflow(exemptWorkflow)) {
    const prefix = dryRun ? '[dry-run] ' : '';
    process.stderr.write(
      `${prefix}reconcile-convergence: exempt workflow '${exemptWorkflow}' -- reconciliation bypassed for spec_group='${specGroupId}'.\n`
    );
    return;
  }

  const mPath = manifestPathFor(specGroupId);
  const mRaw = tryReadJson(mPath);
  if (!mRaw.ok || !mRaw.value) {
    // AC-15.1 / EC-8: non-existent spec group exits 1 with clear error.
    const reason = mRaw.absent ? 'manifest not found' : `manifest parse failed: ${mRaw.error?.message}`;
    process.stderr.write(`reconcile-convergence: ${reason} at ${mPath}\n`);
    process.exit(1);
  }

  let session = loadSession();
  if (!session) {
    session = createEmptySession();
  }

  // Snapshot history length + stale-skip presence BEFORE reconcile so we can
  // detect the two non-event mutation paths: (a) EC-14 audit history entry
  // appended by reconcileConvergenceFromManifest when recent pass evidence is
  // preserved, and (b) lazy-cleanup of stale force_reset_reconcile_skip
  // entries. Both require a saveSession() even when events.length === 0.
  const historyLenBefore = Array.isArray(session.history) ? session.history.length : 0;
  const hadStaleSkip = Boolean(
    session.force_reset_reconcile_skip &&
      session.force_reset_reconcile_skip[specGroupId] &&
      session.force_reset_reconcile_skip[specGroupId].session_id !== session.session_id
  );

  // T-04 / AC-7.3: thread spec_group_id through opts (required field).
  // T-07 / AC-12: propagate dryRun flag so reconcileConvergenceFromManifest
  // prefixes stderr with `[dry-run]` and suppresses session mutation.
  const events = reconcileConvergenceFromManifest(session, mRaw.value, {
    context: 'manual-cli',
    spec_group_id: specGroupId,
    dryRun,
  });

  // Dry-run exits 0 regardless of drift; no history entry; no saveSession.
  // AC-12.3 / AC-13.1: every invocation emits warnings (no idempotency
  // suppression on dry-run).
  if (dryRun) {
    if (events.length === 0) {
      process.stderr.write(
        `[dry-run] reconcile-convergence: no drift detected for '${specGroupId}' (no-op)\n`
      );
    } else {
      process.stderr.write(
        `[dry-run] reconcile-convergence: would seed ${events.length} gate(s) for '${specGroupId}': ${events.map(e => e.gate).join(', ')}\n`
      );
    }
    return;
  }

  const historyLenAfter = Array.isArray(session.history) ? session.history.length : 0;
  const historyChanged = historyLenAfter > historyLenBefore;

  if (events.length === 0) {
    // Persist any side-effects that reconcile produced without generating a
    // seed event: EC-14 audit history entry or stale-skip cleanup.
    if (historyChanged || hadStaleSkip) {
      saveSession(session);
    }
    console.error(`reconcile-convergence: no drift detected for '${specGroupId}' (no-op)`);
    return;
  }

  // AC-38.1 / T-09: history-entry action name + context field.
  // Decision (T-09): keep existing action name `convergence_manifest_seeded` to
  // minimize churn across downstream history-parsers and tests; update the
  // context field from legacy 'reconcile-convergence-cli' (via) to the PRD
  // 'manual-cli' value (matches AC-11.1 requirement for annotation).
  addHistoryEntry(session, 'convergence_manifest_seeded', {
    spec_group_id: specGroupId,
    events,
    message: `Seeded ${events.length} gate(s) via reconcile-convergence CLI`,
    context: 'manual-cli',
    // Keep legacy `via` field for backward-compat with existing history parsers.
    via: 'reconcile-convergence',
  });
  saveSession(session);
  console.error(
    `reconcile-convergence: seeded ${events.length} gate(s) for '${specGroupId}': ${events.map(e => e.gate).join(', ')}`
  );
}

/**
 * transition-phase - Update current phase.
 *
 * Extended signature (ws-dag-substages as-002c / as-004c):
 *   - substage: optional short-form substage (pre-impl | pre-test |
 *     pre-orch; REQ-004 / as-024 removed the review-phase short form).
 *     Only consulted when newPhase === 'challenging'; on a challenger
 *     transition the substage is appended to
 *     session.substages_visited.challenging (deduped) and a
 *     dag.substage.admitted log line is emitted.
 *   - requestedWorkflow: optional workflow from --workflow flag. When
 *     provided and differs from session.active_work.workflow (for
 *     non-exempt current workflows), the call is rejected with
 *     WORKFLOW_IMMUTABLE and session state is NOT mutated (NFR-21 / AC-C7).
 */
function opTransitionPhase(newPhase, substage = null, requestedWorkflow = null) {
  if (!newPhase) {
    throw new Error('Usage: transition-phase <new_phase> [<substage>] [--workflow <W>]');
  }

  validatePhase(newPhase);

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    throw new Error('No active work. Run "start-work" first.');
  }

  // WORKFLOW_IMMUTABLE check (ws-dag-substages as-004c / AC-C7 / NFR-21).
  // Must run BEFORE any session mutation so a rejected downgrade leaves
  // session state untouched.
  if (requestedWorkflow !== null) {
    const immutableErr = checkWorkflowImmutable(session, requestedWorkflow);
    if (immutableErr) {
      console.error(immutableErr.message);
      process.exit(1);
    }
  }

  // Normalize and validate substage when newPhase === 'challenging'.
  // Invalid / out-of-enum values are rejected before populate.
  let normalizedSubstage = null;
  if (newPhase === 'challenging' && substage) {
    normalizedSubstage = normalizeSubstage(substage);
    if (!VALID_SUBSTAGES.includes(normalizedSubstage)) {
      throw new Error(
        `Invalid substage '${substage}'. Valid substages: ${VALID_SUBSTAGES.join(', ')}.`
      );
    }
  }

  const oldPhase = session.active_work.current_phase;

  // Warn if transitioning from journaling to complete without journal created
  if (oldPhase === 'journaling' && newPhase === 'complete') {
    if (session.phase_checkpoint?.journal_required === true &&
        session.phase_checkpoint?.journal_created !== true) {
      console.error(
        `Warning: Transitioning from 'journaling' to 'complete' but journal_created is not true. ` +
        `A journal entry should be created before completing journal-only workflow.`
      );
    }
  }

  // F-C9 in-flight migration (ws-dag-substages / AC-C6 F-C9): backfill
  // session.substages_visited to {} when absent, BEFORE any validation that
  // may throw. This guarantees pre-merge sessions that pre-date the as-002c
  // landing get the field initialized on first transition-phase even when
  // DAG/obligation checks subsequently block the transition. Persisted below
  // via early saveSession when the DAG path blocks.
  if (session.substages_visited === undefined || session.substages_visited === null) {
    session.substages_visited = {};
  }

  // --- DAG-based predecessor validation (DEC-001: replaces linear index ordering) ---
  const workflow = getWorkflowType(session);
  const enforcementLevel = getEnforcementLevel(session);

  // Ensure phase_checkpoint exists before touching nested enforcement fields
  // (backward compatibility — pre-phase_checkpoint sessions or test stubs).
  if (!session.phase_checkpoint || typeof session.phase_checkpoint !== 'object') {
    session.phase_checkpoint = {};
  }

  // Ensure enforcement fields exist (backward compatibility)
  if (!session.phase_checkpoint.phase_skip_warnings) {
    session.phase_checkpoint.phase_skip_warnings = {};
  }
  if (session.phase_checkpoint.enforcement_counter === undefined) {
    session.phase_checkpoint.enforcement_counter = 0;
    session.phase_checkpoint._counter_checksum = computeCounterChecksum(0);
  }

  // Verify enforcement_counter integrity before processing (REQ-012, EC-9)
  verifyCounterIntegrity(session);
  // Re-read enforcement level in case integrity check degraded it to warn-only
  const effectiveEnforcementLevel = getEnforcementLevel(session);

  // Check enforcement: exempt workflows skip entirely (REQ-013)
  if (!EXEMPT_WORKFLOWS.includes(workflow) && effectiveEnforcementLevel !== 'off') {
    const graph = getPredecessorGraph(workflow);

    if (graph) {
      // Find all mandatory predecessors for the target phase
      const predecessors = graph[newPhase] || [];
      const skippedPredecessors = [];

      for (const pred of predecessors) {
        if (!wasPredecessorVisited(pred, session)) {
          skippedPredecessors.push(pred);
        }
      }

      if (skippedPredecessors.length > 0) {
        // Format skipped predecessors for human-readable output
        const skippedNames = skippedPredecessors.map(p => {
          const match = p.match(/^challenging:(.+)$/);
          return match ? `challenging (${match[1]})` : p;
        });

        // Check if any of these have been warned about before (graduated enforcement)
        let shouldBlock = false;

        for (const pred of skippedPredecessors) {
          const currentCount = session.phase_checkpoint.phase_skip_warnings[pred] || 0;

          if (currentCount > 0 && effectiveEnforcementLevel === 'graduated') {
            // Repeated skip in graduated mode: block (REQ-007)
            shouldBlock = true;
          }

          // Increment skip counter
          session.phase_checkpoint.phase_skip_warnings[pred] = currentCount + 1;
          session.phase_checkpoint.enforcement_counter++;
          session.phase_checkpoint._counter_checksum = computeCounterChecksum(session.phase_checkpoint.enforcement_counter);
        }

        if (shouldBlock) {
          // Save updated counters before blocking
          saveSession(session);
          console.error(
            `Error: Mandatory predecessor phase(s) skipped repeatedly: ${skippedNames.join(', ')}. ` +
            `Cannot transition to '${newPhase}'. Use 'override-skip' to bypass or 'reset-enforcement' to clear.`
          );
          process.exit(1);
        }

        // First occurrence: warn but allow (REQ-007)
        console.error(
          `Warning: Skipping mandatory predecessor phase(s) for '${newPhase}': ${skippedNames.join(', ')}. ` +
          `Transition allowed (first occurrence). Repeated skips will be blocked.`
        );
      }
    }
  }
  // --- End DAG validation ---

  // --- Obligation validation (status-obligation-enforcement) ---
  // Check outgoing phase obligations BEFORE executing the transition.
  // Runs after DAG validation so predecessor violations are caught first.
  // Implements: REQ-003, REQ-004, REQ-005, REQ-008, REQ-009, REQ-010, REQ-013, REQ-014, REQ-015
  const killSwitchPath = join(CLAUDE_DIR, 'coordination', 'gate-enforcement-disabled');
  const killSwitchActive = existsSync(killSwitchPath);
  if (!EXEMPT_WORKFLOWS.includes(workflow) && effectiveEnforcementLevel !== 'off' && !killSwitchActive) {
    const specGroupId = session.active_work?.spec_group_id;
    if (specGroupId) {
      const manifestPath = join(CLAUDE_DIR, 'specs', 'groups', specGroupId, 'manifest.json');

      try {
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

          // Check for phase-scoped override (REQ-014)
          // CR-M1: Use shared loadOverrides/findMatchingOverride from hook-utils.mjs
          // session-checkpoint.mjs is a CLI utility, not a hook, so no stdin data.
          // Use active_work.spec_group_id as session identifier for override matching (AC-8.5).
          const overrideGateName = `status_obligations:${oldPhase}`;
          let overrideActive = false;

          const overridePath = join(CLAUDE_DIR, 'coordination', 'gate-override.json');
          const overrideList = loadOverrides(overridePath);
          if (overrideList) {
            const matchingOverride = findMatchingOverride(overrideList, overrideGateName, specGroupId);
            if (matchingOverride) {
              overrideActive = true;
            }
          }

          if (overrideActive) {
            // AC-9.4: Record overridden event for each obligation
            const result = validateObligations(oldPhase, manifest);
            for (const v of result.violations) {
              addHistoryEntry(session, 'obligation_violation', {
                phase: oldPhase,
                field: v.field,
                expected_value: v.expected,
                actual_value: v.actual,
                resolution: 'overridden',
              });
            }
          } else {
            // AC-9.3: Check if this is a successful re-attempt after a previous block
            const hadPriorBlock = (session.history || []).some(
              h => h.event_type === 'obligation_violation' &&
                   h.details?.phase === oldPhase &&
                   h.details?.resolution === 'blocked'
            );

            const result = validateObligations(oldPhase, manifest);

            if (!result.passed) {
              // Record violation events (REQ-015: written by enforcement script, not agent)
              for (const v of result.violations) {
                addHistoryEntry(session, 'obligation_violation', {
                  phase: oldPhase,
                  field: v.field,
                  expected_value: v.expected,
                  actual_value: v.actual,
                  resolution: effectiveEnforcementLevel === 'graduated' ? 'blocked' : 'warned',
                });
              }

              if (effectiveEnforcementLevel === 'graduated') {
                // AC-4.4: Block immediately on first occurrence (no grace period)
                saveSession(session);
                const violationLines = result.violations.map(
                  v => `  - ${v.field}: expected ${JSON.stringify(v.expected)}, actual ${v.actual === null ? 'null (not set)' : JSON.stringify(v.actual)}`
                ).join('\n');
                console.error(
                  `Error: Manifest status obligations not satisfied for phase '${oldPhase}'.\n` +
                  `Manifest status inconsistency:\n${violationLines}\n` +
                  `Update the manifest fields listed above before transitioning from '${oldPhase}'.`
                );
                process.exit(1);
              } else {
                // warn-only: emit warning, allow transition (AC-4.2)
                const violationLines = result.violations.map(
                  v => `  - ${v.field}: expected ${JSON.stringify(v.expected)}, actual ${v.actual === null ? 'null (not set)' : JSON.stringify(v.actual)}`
                ).join('\n');
                console.error(
                  `Warning: Manifest status obligations not satisfied for phase '${oldPhase}'.\n` +
                  `Manifest status inconsistency:\n${violationLines}\n` +
                  `Transition allowed (warn-only mode).`
                );
              }
            } else if (hadPriorBlock) {
              // AC-9.3: Successful re-attempt after prior block -- record "updated" events
              // The obligations for this phase now all pass after agent corrected the manifest
              const priorViolations = (session.history || []).filter(
                h => h.event_type === 'obligation_violation' &&
                     h.details?.phase === oldPhase &&
                     h.details?.resolution === 'blocked'
              );
              // Record one "updated" event per field that was previously blocked
              const seenFields = new Set();
              for (const h of priorViolations) {
                const fieldName = h.details?.field;
                if (fieldName && !seenFields.has(fieldName)) {
                  seenFields.add(fieldName);
                  addHistoryEntry(session, 'obligation_violation', {
                    phase: oldPhase,
                    field: fieldName,
                    expected_value: h.details?.expected_value,
                    actual_value: h.details?.expected_value, // now matches expected
                    resolution: 'updated',
                  });
                }
              }
            }
          }
        } else {
          // AC-7.1: Missing manifest file -- fail-open with warning
          console.error(`Warning: Obligation validation skipped -- manifest not found at ${manifestPath}`);
        }
      } catch (err) {
        // AC-7.2: Fail-open on structural errors (malformed JSON, read failure) (REQ-010)
        console.error(`Warning: Obligation validation skipped (structural error): ${err.message}`);
      }
    }
    // No spec_group_id: skip silently (REQ-009, AC-6.5)
  }
  // --- End obligation validation ---

  session.active_work.current_phase = newPhase;
  session.phase_checkpoint.phase = newPhase;

  // Clear next_actions on phase transition (they'll need to be re-evaluated)
  session.phase_checkpoint.next_actions = [];

  // --- Populate substages_visited when target is 'challenging' ---
  // sg-workflow-convergence-bugs / ws-dag-substages / as-002c.
  // Sole-writer invariant (R-021 / NFR-19): this is the only mutation call
  // site for session.substages_visited.
  const historyDetails = {
    from_phase: oldPhase,
    to_phase: newPhase,
    spec_group_id: session.active_work.spec_group_id,
    message: `Phase transition: ${oldPhase} -> ${newPhase}`
  };
  if (newPhase === 'challenging' && normalizedSubstage) {
    populateSubstageVisited(session, 'challenging', normalizedSubstage);
    // Attach substage to history details so obligation-check can distinguish
    // post-upgrade entries from pre-upgrade legacy bare-`challenging` entries
    // (as-006c / AC-C-LEGACY-VISIT).
    historyDetails.substage = normalizedSubstage;
  }

  addHistoryEntry(session, 'phase_transition', historyDetails);

  // as-005 / REQ-005 / AC-005.6 trigger 1 (spec-complete): re-read manifest
  // to check `review_state === 'APPROVED'`. A transition into any phase where
  // the manifest already records APPROVED is the canonical signal that the
  // spec group has advanced to the sink state where no further test-writer
  // unlock should persist. Per-key: only clears unlock for THIS sg-id, not
  // every unlock in active_work (EC-WS2-2 per-key isolation). Fail-soft on
  // audit-append failure so spec-complete transitions are not wedged by a
  // broken chain.
  const spSpecGroupId = session.active_work?.spec_group_id || null;
  if (spSpecGroupId) {
    try {
      const spManifestPath = manifestPathFor(spSpecGroupId);
      if (existsSync(spManifestPath)) {
        const spManifest = JSON.parse(readFileSync(spManifestPath, 'utf8'));
        if (spManifest && spManifest.review_state === 'APPROVED') {
          evaluateRefenceTrigger(session, spSpecGroupId, 'spec-complete');
        }
      }
    } catch (err) {
      console.error(
        `Warning: test-writer-unlock re-fence on spec-complete failed for ` +
        `'${spSpecGroupId}': ${err && err.message}. Phase transition persists; ` +
        `unlock will clear via TTL or next trigger.`
      );
    }
  }

  saveSession(session);
  console.error(`Transitioned from '${oldPhase}' to '${newPhase}'`);
}

/**
 * complete-atomic-spec - Mark an atomic spec as done.
 */
function opCompleteAtomicSpec(atomicSpecId) {
  if (!atomicSpecId) {
    throw new Error('Usage: complete-atomic-spec <atomic_spec_id>');
  }

  validateAtomicSpecId(atomicSpecId);

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    throw new Error('No active work. Run "start-work" first.');
  }

  if (!session.phase_checkpoint) {
    throw new Error('No phase checkpoint. This should not happen.');
  }

  // Check if already completed
  if (session.phase_checkpoint.atomic_specs_completed.includes(atomicSpecId)) {
    console.error(`Atomic spec '${atomicSpecId}' is already marked as completed.`);
    return;
  }

  // Remove from pending if present
  const pendingIndex = session.phase_checkpoint.atomic_specs_pending.indexOf(atomicSpecId);
  if (pendingIndex !== -1) {
    session.phase_checkpoint.atomic_specs_pending.splice(pendingIndex, 1);
  }

  // Add to completed
  session.phase_checkpoint.atomic_specs_completed.push(atomicSpecId);

  addHistoryEntry(session, 'checkpoint_saved', {
    spec_group_id: session.active_work.spec_group_id,
    message: `Completed atomic spec: ${atomicSpecId}`
  });

  saveSession(session);
  console.error(`Marked atomic spec '${atomicSpecId}' as completed.`);
}

/**
 * dispatch-subagent - Track subagent dispatch.
 *
 * Supports optional --stage flag for challenger subagent dispatches (DEC-004).
 * Usage: dispatch-subagent <task_id> <type> <description> [--stage <stage>]
 */
function opDispatchSubagent(taskId, subagentType, description, stage, stageSource) {
  if (!subagentType || !description) {
    throw new Error('Usage: dispatch-subagent <task_id> <subagent_type> <description> [--stage <stage>]');
  }

  // If taskId not provided, generate one
  const finalTaskId = taskId || generateTaskId();

  validateSubagentType(subagentType);

  // Task 7 / AC-1.6: when the description looks like a standalone path (no
  // whitespace; contains a separator or parent-traversal marker), enforce the
  // shared path-validate helper so absolute paths, `..` traversals, and
  // symlinked targets are rejected before being written to session.json.
  //
  // sec-pathval-c5f02103: pass the NORMALIZED candidate to validatePath so
  // encoded (`%2e%2e`) and unicode-homoglyph (U+2215 etc.) bypasses are
  // actually rejected, not just detected by the gate. path-validate is
  // POSIX-ASCII-only by contract, so normalization must happen HERE.
  if (looksLikeStandalonePath(description)) {
    const normalizedDescription = normalizePathCandidate(description);
    const validation = validatePath(normalizedDescription, { allowNull: false });
    if (!validation.valid) {
      throw new Error(
        `dispatch-subagent desc rejected by path-validate: ${validation.reason}` +
          (validation.detail ? ` (${validation.detail})` : '')
      );
    }
  }

  // Validate stage if provided (REQ-003)
  if (stage) {
    if (!VALID_STAGES.includes(stage)) {
      throw new Error(`Invalid stage '${stage}'. Valid stages: ${VALID_STAGES.join(', ')}`);
    }
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  // AC-11.7 (sg-enforcement-layer-gaps Task 25): enforcement_compromised blocks
  // all new dispatches. Operator must manually reset session.enforcement_compromised
  // to false after reviewing the mismatch count.
  if (session.enforcement_compromised === true) {
    throw new Error(
      'dispatch-subagent blocked: session.enforcement_compromised is true. ' +
        'Operator review required. Reset session.enforcement_compromised to false to resume.'
    );
  }

  // Last-write-wins duplicate handling (AC-9.7, AC-9.10 — chk-hook-d5a23f98).
  // PostToolUse/SubagentStop hooks may legitimately re-fire (tool retries,
  // transcript replays). The prior `throw` behavior fails-closed on valid
  // duplicates; replacement is last-write-wins with audit-trail preservation.
  const existingInFlight = session.subagent_tasks.in_flight.find(
    t => t.task_id === finalTaskId
  );
  const existingCompleted = session.subagent_tasks.completed_this_session.find(
    t => t.task_id === finalTaskId
  );
  const existing = existingInFlight || existingCompleted;

  // AC-11.4 / AC-11.5: authoritative subagent_type source is the first-record
  // (PreToolUse / prior-write). On mismatch, REJECT this write, log with
  // severity:"high", bump per-session mismatch count. AC-11.7: 4th mismatch
  // flips enforcement_compromised:true and blocks subsequent dispatches.
  // AC-11.8: rejection message is generic to avoid type-hint leakage.
  //
  // chk-backcompat-fa103506: Include the "type mismatch" class label in the
  // error message so dispatch-record-hook.mjs caller regex (/type mismatch/i)
  // matches and routes through the GENERIC_REJECT_MESSAGE branch instead of
  // noisy raw-stderr warnings. The class label "type mismatch" is NOT a
  // type-hint (no specific agent-type names leak) — AC-11.8 is preserved.
  if (existing && existing.subagent_type !== subagentType) {
    if (!session.active_work) {
      // Can't anchor history without active_work; still reject.
      throw new Error('record rejected: type mismatch');
    }
    // Initialize mismatch counter
    const prior = session.active_work.type_mismatch_count || 0;
    const next = prior + 1;
    session.active_work.type_mismatch_count = next;
    addHistoryEntry(session, 'subagent_type_mismatch_rejected', {
      task_id: finalTaskId,
      spec_group_id: session.active_work?.spec_group_id || null,
      mismatch_count: next,
      severity: 'high',
      // NOTE: AC-11.6 requires severity:"high" and the rejection to be audited,
      // but types are intentionally NOT leaked in messages (AC-11.8). They are
      // preserved internally in the history entry for operator forensics.
      authoritative_type: existing.subagent_type,
      rejected_type: subagentType,
      message: 'Dispatch rejected: subagent_type does not match prior record',
    });
    // AC-11.7: 4th mismatch sets the compromise flag + blocks subsequent writes.
    if (next >= 4) {
      session.enforcement_compromised = true;
      addHistoryEntry(session, 'enforcement_compromised_triggered', {
        spec_group_id: session.active_work?.spec_group_id || null,
        mismatch_count: next,
        severity: 'high',
        message:
          'enforcement_compromised=true after 4th subagent_type mismatch. All subsequent dispatches blocked until operator review.',
      });
    }
    saveSession(session);
    // AC-11.8: generic rejection — no type hint leakage.
    // chk-backcompat-fa103506: class label "type mismatch" is generic enough
    // to satisfy AC-11.8 while letting the hook regex classify correctly.
    throw new Error('record rejected: type mismatch');
  }

  // Helper: cap subagent_tasks_history at 500 entries (AC-9.10 FIFO retention).
  function appendOverwriteAudit(dispatchId, priorValue, newValue) {
    if (!session.active_work) return;
    if (!Array.isArray(session.active_work.subagent_tasks_history)) {
      session.active_work.subagent_tasks_history = [];
    }
    session.active_work.subagent_tasks_history.push({
      dispatch_id: dispatchId,
      prior_value: priorValue,
      new_value: newValue,
      timestamp: now(),
      event_type: 'duplicate-overwrite',
    });
    // FIFO evict: cap at 500.
    const CAP = 500;
    if (session.active_work.subagent_tasks_history.length > CAP) {
      const excess =
        session.active_work.subagent_tasks_history.length - CAP;
      session.active_work.subagent_tasks_history.splice(0, excess);
    }
  }

  const task = {
    task_id: finalTaskId,
    subagent_type: subagentType,
    description,
    dispatched_at: now(),
    completed_at: null,
    status: 'in_flight',
    result_summary: null,
    spec_group_id: session.active_work?.spec_group_id || null,
    atomic_spec_id: null
  };

  // Store stage on dispatch record for challenger subagents (REQ-003, DEC-004)
  if (stage) {
    task.stage = stage;
  }

  // Stage-field provenance: `auto_detected` when the PreToolUse hook spawned this
  // subprocess, `cli` when an operator invoked the CLI explicitly, or
  // `lock_skipped` (DEC-CHK-003) when lock-contention forced fail-open.
  if (stageSource) {
    if (!['auto_detected', 'cli', 'lock_skipped'].includes(stageSource)) {
      throw new Error(
        `Invalid --stage-source '${stageSource}'. Valid: auto_detected | cli | lock_skipped`
      );
    }
    task.stage_source = stageSource;
  } else if (stage) {
    // Default provenance: operator-invoked CLI.
    task.stage_source = 'cli';
  }

  if (existing) {
    // Last-write-wins: overwrite the live entry. Preserve audit trail first.
    const priorSnapshot = { ...existing };
    appendOverwriteAudit(finalTaskId, priorSnapshot, task);

    // Replace entry in its current bucket.
    if (existingInFlight) {
      const idx = session.subagent_tasks.in_flight.indexOf(existingInFlight);
      session.subagent_tasks.in_flight[idx] = task;
    } else if (existingCompleted) {
      // Existing already completed: new entry enters in_flight (fresh dispatch).
      session.subagent_tasks.in_flight.push(task);
    }

    // AC-9.7 warning: log to stderr so operator visibility is preserved even
    // though the call succeeds (unlike the prior throw).
    console.error(
      `[session-checkpoint] WARNING: dispatch-subagent duplicate task_id '${finalTaskId}' — last-write-wins (prior audit appended to subagent_tasks_history; see session.json).`
    );
    addHistoryEntry(session, 'subagent_dispatched_overwrite', {
      task_id: finalTaskId,
      subagent_type: subagentType,
      spec_group_id: session.active_work?.spec_group_id,
      message: `Overwrote prior dispatch for ${subagentType} (last-write-wins)`,
    });
  } else {
    session.subagent_tasks.in_flight.push(task);

    const historyDetails = {
      task_id: finalTaskId,
      subagent_type: subagentType,
      spec_group_id: session.active_work?.spec_group_id,
      message: `Dispatched ${subagentType}: ${description}`
    };

    // Include stage in history for traceability
    if (stage) {
      historyDetails.stage = stage;
      historyDetails.message = `Dispatched ${subagentType} (stage: ${stage}): ${description}`;
    }

    addHistoryEntry(session, 'subagent_dispatched', historyDetails);
  }

  saveSession(session);
  console.error(`Dispatched subagent '${subagentType}' with task_id '${finalTaskId}'${stage ? ` (stage: ${stage})` : ''}`);
}

/**
 * complete-subagent - Mark subagent as complete.
 */
function opCompleteSubagent(taskId, resultSummary) {
  if (!taskId) {
    throw new Error('Usage: complete-subagent <task_id> <result_summary>');
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  // Find task in in_flight
  const taskIndex = session.subagent_tasks.in_flight.findIndex(t => t.task_id === taskId);

  if (taskIndex === -1) {
    // Check if already completed
    const completedTask = session.subagent_tasks.completed_this_session.find(t => t.task_id === taskId);
    if (completedTask) {
      console.error(`Task '${taskId}' is already completed.`);
      return;
    }
    throw new Error(`Task '${taskId}' not found in in_flight tasks.`);
  }

  const task = session.subagent_tasks.in_flight[taskIndex];

  // Remove from in_flight
  session.subagent_tasks.in_flight.splice(taskIndex, 1);

  // Update task
  task.completed_at = now();
  task.status = 'completed';
  task.result_summary = resultSummary || 'Completed successfully';

  // Add to completed
  session.subagent_tasks.completed_this_session.push(task);

  addHistoryEntry(session, 'subagent_completed', {
    task_id: taskId,
    subagent_type: task.subagent_type,
    spec_group_id: task.spec_group_id,
    message: `Completed ${task.subagent_type}: ${resultSummary || 'No summary'}`
  });

  saveSession(session);
  console.error(`Completed subagent task '${taskId}'`);
}

/**
 * clear-async-mode - Delete the shape-lint-async-mode sentinel so the
 * PostToolUse shape-lint hook resumes synchronous validation (AC-6.6).
 *
 * Idempotent: no-op if the sentinel does not exist. Emits a history entry so
 * async-mode lifecycle is auditable. Does NOT touch the async-mode circuit
 * breaker in session.json — that lives under convergence_log_failures[].
 *
 * Spec: sg-enforcement-layer-gaps Task 13 / REQ-M1-008 / AC-6.6.
 */
function opClearAsyncMode() {
  const sentinelPath = join(CLAUDE_DIR, 'coordination', 'shape-lint-async-mode');
  let removed = false;
  if (existsSync(sentinelPath)) {
    try {
      unlinkSync(sentinelPath);
      removed = true;
    } catch (err) {
      throw new Error(
        `clear-async-mode: failed to remove sentinel at ${sentinelPath}: ${err.message}`
      );
    }
  }

  // Best-effort history entry. session.json may not exist yet (first-run) —
  // that is acceptable; the sentinel removal is the authoritative action.
  const session = loadSession();
  if (session) {
    addHistoryEntry(session, 'shape_lint_async_mode_cleared', {
      sentinel_path: sentinelPath,
      removed,
      message: removed
        ? 'Cleared shape-lint-async-mode sentinel; shape-lint will resume sync mode.'
        : 'shape-lint-async-mode sentinel was already absent (no-op).',
    });
    saveSession(session);
  }

  console.error(
    removed
      ? `Cleared async-mode sentinel at ${sentinelPath}`
      : `async-mode sentinel already absent at ${sentinelPath} (no-op)`
  );
}

/**
 * toggle-kill-switch - Create or remove the `.claude/coordination/gate-enforcement-disabled`
 * sentinel. Routes through `audit-append.mjs` to record an audit entry.
 *
 * Usage: toggle-kill-switch <create|remove> --rationale "<text>"
 *
 * Operator-direct `touch` / `rm` calls are blocked by `workflow-file-protection.mjs`
 * (as-006 + as-019) and redirected here. This subcommand is the sole authorized
 * toggle path.
 */
function opToggleKillSwitch(action, rationale) {
  if (!['create', 'remove'].includes(action)) {
    throw new Error('Usage: toggle-kill-switch <create|remove> --rationale "<text>"');
  }
  if (!rationale || typeof rationale !== 'string' || rationale.trim().length === 0) {
    throw new Error('toggle-kill-switch requires --rationale "<text>"');
  }

  const sentinelPath = join(CLAUDE_DIR, 'coordination', 'gate-enforcement-disabled');

  // Invoke audit-append BEFORE mutating the sentinel so a failed audit
  // never leaves a toggled sentinel without a corresponding audit entry.
  const auditCli = join(CLAUDE_DIR, 'scripts', 'audit-append.mjs');
  if (existsSync(auditCli)) {
    const res = spawnSync(
      'node',
      [auditCli, action, '--rationale', rationale, '--actor', process.env.USER || 'operator'],
      { encoding: 'utf-8', timeout: 5_000 },
    );
    if (res.status !== 0) {
      throw new Error(
        `toggle-kill-switch: audit-append exit=${res.status}. stderr=${(res.stderr || '').slice(0, 500)}`
      );
    }
  } else {
    console.error(
      `[session-checkpoint] WARN: audit-append.mjs not found at ${auditCli}; kill-switch toggle proceeding without audit entry`
    );
  }

  if (action === 'create') {
    if (!existsSync(dirname(sentinelPath))) {
      mkdirSync(dirname(sentinelPath), { recursive: true });
    }
    // Create empty sentinel marker file.
    writeFileSync(sentinelPath, '');
    console.error(`kill-switch created: ${sentinelPath}`);
  } else {
    if (existsSync(sentinelPath)) {
      unlinkSync(sentinelPath);
      console.error(`kill-switch removed: ${sentinelPath}`);
    } else {
      console.error(`kill-switch already absent: ${sentinelPath}`);
    }
  }
}

/**
 * override-enforcement <advisory|coercive> --rationale "<text>"
 *
 * sg-pipeline-efficiency-ws1-convergence-pruning / as-019 / REQ-013 / EC-14
 *
 * Session-scoped enforcement override: flips the effective enforcement mode
 * for the current session only (advisory ↔ coercive). Per REQ-013, the `off`
 * value is NEVER permitted via session override — operators may only disable
 * enforcement via a signed commit to the enforcement-flag file.
 *
 * Semantics:
 *   - Writes to session scope at `session.active_work.enforcement_override`;
 *     does NOT modify `.claude/config/pipeline-efficiency-enforcement.json`
 *     (operator-signed only, FULL_BLOCK-protected — AC19.6).
 *   - Does NOT mutate `session.active_work.threshold_snapshot`; the snapshot
 *     remains immutable for the session (AC19.5, EC-14). Mid-session flag
 *     flips are reflected in the NEXT session only.
 *   - Appends an audit entry (event_class `session_override_flip`, NFR-5
 *     item d) BEFORE persisting the session mutation so a failed audit
 *     never leaves a session with an override and no audit record (mirrors
 *     opToggleKillSwitch ordering).
 *
 * Acceptance Criteria:
 *   - AC19.1: `override-enforcement advisory` succeeds, updates session scope.
 *   - AC19.2: `override-enforcement coercive` succeeds, updates session scope.
 *   - AC19.3: `override-enforcement off` rejected with structured error
 *             `SESSION_OVERRIDE_OFF_REJECTED`.
 *   - AC19.4: Every accepted override appends audit entry class
 *             'session_override_flip' (9-class named enum, as-003/as-017).
 *   - AC19.5: Does not mutate SessionThresholdSnapshot.
 *   - AC19.6: Does not mutate enforcement-flag file.
 *
 * @param {string} mode       'advisory' | 'coercive'; 'off' rejected
 * @param {string} rationale  non-empty rationale string (audit payload)
 */
function opOverrideEnforcement(mode, rationale) {
  // AC19.3: reject 'off' with a dedicated structured error BEFORE Zod surfaces
  // a generic "invalid enum" failure. Callers can branch on the `.code`
  // discriminator.
  //
  // sec-authz-c8e51f33: emit typed SessionOverrideError (was plain Error)
  // so callers can branch on `err.code` instead of substring-matching
  // `err.message`.
  if (mode === 'off') {
    // Message retains the `SESSION_OVERRIDE_OFF_REJECTED:` prefix so stderr
    // grep oracles (AC19.3 observability contract) continue to match the
    // bare token after Node's default Error→stderr rendering. The typed
    // `.code` is the structured discriminator for programmatic callers;
    // the prefix is the human/log discriminator.
    throw new SessionOverrideError(
      'SESSION_OVERRIDE_OFF_REJECTED',
      'SESSION_OVERRIDE_OFF_REJECTED: session-override cannot set mode=off. ' +
        'The `off` value is reserved for operator-signed flag-file edits ' +
        '(REQ-013). Use `advisory` or `coercive` for session-scoped overrides.'
    );
  }

  // Structural usage check (flag presence / type) before semantic validation.
  if (!mode || typeof mode !== 'string') {
    throw new SessionOverrideError(
      'SESSION_OVERRIDE_USAGE_ERROR',
      'Usage: override-enforcement <advisory|coercive> --rationale "<text>"'
    );
  }

  // AC19.1 / AC19.2: narrowed enum rejects anything outside {advisory,
  // coercive}. 'off' is also rejected here as a defense-in-depth layer
  // behind the explicit SESSION_OVERRIDE_OFF_REJECTED short-circuit above,
  // though that branch handles the named case first for a stable code.
  const parseResult = sessionOverrideModeSchema.safeParse(mode);
  if (!parseResult.success) {
    // Keep the prefix token in the message for stderr-grep parity with
    // SESSION_OVERRIDE_OFF_REJECTED above; `.code` remains the canonical
    // programmatic discriminator.
    throw new SessionOverrideError(
      'SESSION_OVERRIDE_INVALID_MODE',
      `SESSION_OVERRIDE_INVALID_MODE: mode "${mode}" is not a valid session ` +
        `override value. Expected one of: advisory, coercive. ` +
        `(schema: ${parseResult.error.message})`
    );
  }
  const newMode = parseResult.data;

  // Rationale required for traceability; matches the convention shared with
  // opToggleKillSwitch / opOverrideSkip / opResetEnforcement. Appears in the
  // audit payload (NFR-5 event d) so operators can reconstruct why a session
  // diverged from the file-based mode.
  if (
    !rationale ||
    typeof rationale !== 'string' ||
    rationale.trim().length === 0
  ) {
    throw new SessionOverrideError(
      'SESSION_OVERRIDE_USAGE_ERROR',
      'override-enforcement requires --rationale "<text>"'
    );
  }

  // sec-authz-c8e51f33: kill-switch sentinel short-circuits coercive accepts.
  // When the operator has created `.claude/coordination/pipeline-efficiency-disabled`
  // via signed commit, ALL pipeline-efficiency enforcement is suspended
  // (NFR-14). Allowing a session to flip back into coercive mode would
  // silently re-enable the enforcement the operator just turned off. Reject
  // coercive overrides with SENTINEL_ACTIVE and instruct the caller to
  // remove the sentinel first.
  //
  // Advisory overrides remain permitted: advisory is the effective mode
  // while the sentinel is active, so an advisory override is a no-op
  // consistency affirmation, not a re-engagement of enforcement.
  if (newMode === 'coercive' && existsSync(PIPELINE_EFFICIENCY_KILL_SWITCH_PATH)) {
    throw new SessionOverrideError(
      'SENTINEL_ACTIVE',
      'SENTINEL_ACTIVE: pipeline-efficiency kill-switch sentinel is active ' +
        `at ${PIPELINE_EFFICIENCY_KILL_SWITCH_PATH}. All pipeline-efficiency ` +
        'enforcement is suspended (NFR-14). Session-scoped coercive ' +
        'overrides are rejected while the sentinel is present to prevent ' +
        'silent re-engagement of enforcement. Remove the sentinel via ' +
        'signed commit before flipping to coercive.'
    );
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }
  if (!session.active_work) {
    throw new Error('No active work. Run "start-work" first.');
  }

  // Compute `prior_mode` for the audit payload:
  //   - If a prior session override is present, that's the effective mode
  //     being replaced (override → override flip).
  //   - Otherwise, fall back to the file-based mode (getCurrentMode from
  //     as-015 reader; returns 'advisory' when flag file is absent per
  //     as-015 DEFAULT_MODE_WHEN_FILE_MISSING).
  //
  // Note: getCurrentMode() may throw EnforcementConfigInvalidError if the
  // on-disk flag file is malformed. We do NOT rescue that error — a
  // corrupt flag file is an operational incident the operator must fix
  // before session overrides can proceed (fail-closed).
  const existingOverride =
    session.active_work.enforcement_override &&
    typeof session.active_work.enforcement_override.mode === 'string'
      ? session.active_work.enforcement_override.mode
      : null;
  const priorMode = existingOverride || getCurrentMode();

  // AC19.4: append audit entry BEFORE mutating session scope. A failed
  // append throws (AuditLogError) and leaves the session unchanged — the
  // override is never persisted without a matching audit record.
  //
  // actor: 'agent' — session-checkpoint runs in agent context. Operator-
  // driven overrides would be rare and would pass actor explicitly; the
  // appender's 'agent' default matches REQ-013's intent that overrides are
  // agent-initiated for experimentation.
  const overrideTimestamp = now();
  appendAuditEntry(
    'session_override_flip',
    `override-${priorMode}-to-${newMode}`,
    {
      new_mode: newMode,
      prior_mode: priorMode,
      rationale: rationale.trim(),
      spec_group_id: session.active_work.spec_group_id || null,
    },
    { timestamp: overrideTimestamp }
  );

  // AC19.1 / AC19.2 / AC19.5 / AC19.6: write override to session scope only.
  // SessionThresholdSnapshot is left untouched (assertSnapshotImmutable in
  // saveSession validates this); the enforcement-flag file is not opened.
  session.active_work.enforcement_override = {
    mode: newMode,
    rationale: rationale.trim(),
    effective_at: overrideTimestamp,
    prior_mode: priorMode,
  };

  // Session history breadcrumb (distinct from the hash-chained audit log —
  // the audit log is the authoritative record; this breadcrumb aids session
  // introspection via `get-status` without hash-chain dependency).
  addHistoryEntry(session, 'session_override_flip', {
    new_mode: newMode,
    prior_mode: priorMode,
    rationale: rationale.trim(),
    spec_group_id: session.active_work.spec_group_id || null,
  });

  saveSession(session);

  console.error(
    `session-override applied: ${priorMode} → ${newMode} (rationale: ${rationale.trim()})`
  );
}

// =============================================================================
// sg-pipeline-efficiency-ws2-practice-2.4 / as-003 / REQ-005
// record-test-writer-unlock CLI (sole-writer for test_writer_unlock)
// =============================================================================

/**
 * TTL window for a recorded unlock. Anchored at `first_failure_at` (AC-005.3,
 * spec.md § TestWriterUnlockEntry). The hook re-checks `now() < unlocked_until`
 * on every implementation-file read (AC-005.5 cooperative-check).
 *
 * 5 minutes ≙ 300 000 ms. Named constant, not a magic literal (code-quality.md).
 */
const TEST_WRITER_UNLOCK_TTL_MS = 5 * 60 * 1000;

/**
 * File-mode for the per-session HMAC secret. Owner read/write only; no group
 * or world access. Matches Q1 resolution in spec.md (Open Questions).
 */
const SESSION_HMAC_SECRET_MODE = 0o600;

/**
 * HMAC secret byte length for `crypto.randomBytes`. Matches as-002/Q1:
 * 256-bit key stored as raw bytes so the single-read atomicity argument
 * holds (one `readFileSync` yields the whole key).
 */
const SESSION_HMAC_SECRET_BYTES = 32;

/**
 * Resolve the absolute path of the per-session HMAC secret.
 *
 * Path shape: `.claude/coordination/.session-hmac-<session-id>` (spec.md Q1).
 * `session_id` is the loaded session's identifier; callers MUST pass a
 * non-empty string. Leading dot in the basename keeps the file hidden by
 * default.
 *
 * @param {string} sessionId non-empty session identifier
 * @returns {string} absolute path
 */
function sessionHmacSecretPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TestWriterUnlockError(
      'UNLOCK_HMAC_SECRET_ERROR',
      'UNLOCK_HMAC_SECRET_ERROR: session_id missing or non-string; cannot resolve HMAC secret path'
    );
  }
  return join(CLAUDE_DIR, 'coordination', `.session-hmac-${sessionId}`);
}

/**
 * Read the per-session HMAC secret, bootstrapping it (mode 0600, 32 random
 * bytes) if absent. Task 4b (as-003-b) later moves bootstrap into start-work
 * and teardown into close-work; until then this helper handles the missing
 * case so the CLI works end-to-end for tests and the first real bug-fix
 * workstream that invokes it.
 *
 * Fail-closed: any IO failure throws TestWriterUnlockError with code
 * UNLOCK_HMAC_SECRET_ERROR so the caller short-circuits before mutating
 * session.json.
 *
 * Concurrent-dispatch race: Q1 specifies a session-lock at
 * `.claude/coordination/session.lock` guards the create. This helper reuses
 * the existing `acquireLock(LOCK_PATH, ...)` pattern via the session save
 * path — however the secret bootstrap happens BEFORE saveSession in our
 * flow, so we open the file with `wx` (O_EXCL) flag so two concurrent
 * bootstrappers race safely: exactly one writer wins the create; the other
 * sees EEXIST and falls through to a plain read.
 *
 * @param {string} sessionId
 * @returns {Buffer} 32-byte secret
 */
function readOrBootstrapSessionHmacSecret(sessionId) {
  const secretPath = sessionHmacSecretPath(sessionId);

  // security-review Pass 1 SEC-WS2-002: bounded retry loop replaces the prior
  // tail-recursive EEXIST re-read. With unbounded recursion a pathological
  // filesystem (stat-EEXIST race where another writer keeps replacing the
  // file) could blow the stack; a hard cap of 3 attempts converges in the
  // legitimate race (one winner, one retry) and fails closed otherwise.
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Happy path: read existing secret.
    if (existsSync(secretPath)) {
      try {
        const raw = readFileSync(secretPath);
        if (raw.length !== SESSION_HMAC_SECRET_BYTES) {
          throw new TestWriterUnlockError(
            'UNLOCK_HMAC_SECRET_ERROR',
            `UNLOCK_HMAC_SECRET_ERROR: HMAC secret at ${secretPath} is ${raw.length} bytes; expected ${SESSION_HMAC_SECRET_BYTES}`
          );
        }
        return raw;
      } catch (err) {
        if (err instanceof TestWriterUnlockError) throw err;
        throw new TestWriterUnlockError(
          'UNLOCK_HMAC_SECRET_ERROR',
          `UNLOCK_HMAC_SECRET_ERROR: cannot read HMAC secret at ${secretPath}: ${err.message}`
        );
      }
    }

    // Bootstrap path: generate + atomic-exclusive-create.
    const secretDir = dirname(secretPath);
    if (!existsSync(secretDir)) {
      try {
        mkdirSync(secretDir, { recursive: true });
      } catch (err) {
        throw new TestWriterUnlockError(
          'UNLOCK_HMAC_SECRET_ERROR',
          `UNLOCK_HMAC_SECRET_ERROR: cannot create coordination dir ${secretDir}: ${err.message}`
        );
      }
    }

    // Allow test stubbing via globalThis without rewriting all callers.
    const randomBytesImpl =
      (globalThis.__testWriterUnlockCryptoStub &&
        globalThis.__testWriterUnlockCryptoStub.randomBytes) ||
      randomBytes;
    const secret = randomBytesImpl(SESSION_HMAC_SECRET_BYTES);

    // O_WRONLY | O_CREAT | O_EXCL via `wx` flag so concurrent bootstrappers
    // race safely: exactly one process wins; the other gets EEXIST and loops
    // to the re-read branch above.
    let fd;
    try {
      fd = openSync(secretPath, 'wx', SESSION_HMAC_SECRET_MODE);
      writeSync(fd, secret);
      fsyncSync(fd);
      closeSync(fd);
      return secret;
    } catch (err) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      if (err && err.code === 'EEXIST') {
        // Raced with another bootstrapper; retry (bounded).
        lastErr = err;
        continue;
      }
      throw new TestWriterUnlockError(
        'UNLOCK_HMAC_SECRET_ERROR',
        `UNLOCK_HMAC_SECRET_ERROR: cannot create HMAC secret at ${secretPath}: ${err.message}`
      );
    }
  }

  // Attempts exhausted: pathological EEXIST loop (another writer keeps
  // racing us). Fail closed with a structured error so the caller renders
  // a stable stderr code.
  throw new TestWriterUnlockError(
    'UNLOCK_HMAC_SECRET_ERROR',
    `UNLOCK_HMAC_SECRET_ERROR: bootstrap of ${secretPath} did not converge after ${MAX_ATTEMPTS} attempts (last error: ${lastErr && lastErr.message})`
  );
}

/**
 * Read `manifest.spec_mode` for a spec-group, defaulting to 'feature'
 * when the field is absent (AC-005.2 fail-closed default).
 *
 * Returns a two-tuple `{ specMode, manifest }` so callers have the full
 * manifest on hand for downstream decisions. Throws TestWriterUnlockError
 * if the manifest is missing or unreadable — we cannot safely default a
 * missing manifest to feature-mode because absence may indicate a typo'd
 * sg-id and silently rejecting with UNLOCK_MODE_MISMATCH would mask the
 * operator error.
 *
 * @param {string} specGroupId validated sg-id
 * @returns {{ specMode: string, manifest: Record<string, unknown> }}
 */
function readManifestSpecMode(specGroupId) {
  const manifestPath = manifestPathFor(specGroupId);
  const res = tryReadJson(manifestPath);
  if (res.absent) {
    throw new TestWriterUnlockError(
      'UNLOCK_MANIFEST_MISSING',
      `UNLOCK_MANIFEST_MISSING: manifest.json not found for spec_group '${specGroupId}' at ${manifestPath}`
    );
  }
  if (!res.ok) {
    throw new TestWriterUnlockError(
      'UNLOCK_MANIFEST_CORRUPT',
      `UNLOCK_MANIFEST_CORRUPT: manifest.json for spec_group '${specGroupId}' is unreadable: ${res.error}`
    );
  }
  const manifest = res.value || {};
  // Fail-closed default: absent or non-string → 'feature'.
  const rawMode = manifest.spec_mode;
  const specMode =
    typeof rawMode === 'string' && rawMode.length > 0 ? rawMode : 'feature';
  return { specMode, manifest };
}

/**
 * Synchronous wrapper over `mintMarker` from as-004. Resolution order:
 *   1. `globalThis.__testWriterUnlockMarkerStub.mintMarker` — test injection
 *   2. `_mintMarkerReal` — statically imported real module (as-004)
 *
 * Both synchronous. Any error from either path is re-thrown as a
 * TestWriterUnlockError so the CLI renders a stable stderr code.
 *
 * Code-review Pass 1 M3: previously used `createRequire` for lazy CJS-style
 * resolve because as-003 and as-004 shipped on separate parallel branches.
 * With both atomic specs now landed together, the lazy resolve is no longer
 * justified — promoted to a static ESM import at module top so the peer
 * dependency is enforced at load time. The `__testWriterUnlockMarkerStub`
 * override path is retained for tests that need to stub the mint function
 * without rewriting call sites.
 */
function _invokeMintMarker(args) {
  // Test stub takes precedence over the real module so tests can exercise
  // failure paths (e.g. simulate mintMarker throwing) without monkeypatching
  // the module registry.
  const stub = globalThis.__testWriterUnlockMarkerStub;
  if (stub && typeof stub.mintMarker === 'function') {
    try {
      return stub.mintMarker(args);
    } catch (err) {
      throw new TestWriterUnlockError(
        'UNLOCK_MARKER_MINT_FAILED',
        `UNLOCK_MARKER_MINT_FAILED: test-stub mintMarker threw: ${err && err.message}`
      );
    }
  }

  // Real module path — statically imported at module top.
  try {
    return _mintMarkerReal(args);
  } catch (err) {
    throw new TestWriterUnlockError(
      'UNLOCK_MARKER_MINT_FAILED',
      `UNLOCK_MARKER_MINT_FAILED: mintMarker threw: ${err && err.message}`
    );
  }
}

/**
 * as-007 AC7.3 genesis-anchor content preflight.
 *
 * Verifies the hash-chain genesis anchor is present, shape-valid, AND
 * content-canonical (origin-chain invariant: hash === SHA256("")). This is
 * stricter than `pipeline-efficiency-audit-log.mjs readGenesisHash()` which
 * only enforces shape (64-char lowercase hex). A content-corrupted genesis
 * would pass the appender's shape check but silently poison the chain with
 * a wrong prev_hash linkage on seq=1.
 *
 * Fail-closed semantics per spec.md §Testing / §Edge Cases EC-WS2-12
 * (investigation Pass 1 inv-dep-6e2d4a):
 *   - Missing file → GENESIS_ANCHOR_INVALID
 *   - Malformed JSON → GENESIS_ANCHOR_INVALID
 *   - Shape-invalid (seq != 0, hash not 64-hex, signed_by empty) → GENESIS_ANCHOR_INVALID
 *   - Content-corrupted (hash != SHA256("") on origin chain) → GENESIS_ANCHOR_INVALID
 *
 * Origin-chain detection: `previous_genesis_hash === null` means this is the
 * REQ-014 bootstrap genesis (no rotation); hash MUST equal SHA256(""). If
 * `previous_genesis_hash` is non-null, the anchor is a rotation anchor and
 * its hash is operator-minted (not SHA256("")); in that case we only enforce
 * shape (full rotation verification is as-018's job via `walkChain`).
 *
 * @param {string} claudeDir — absolute path to `.claude/` root
 * @returns {{ ok: true } | { ok: false, code: 'GENESIS_ANCHOR_INVALID', detail: string }}
 */
function verifyGenesisForUnlockPreflight(claudeDir) {
  const genesisPath = join(claudeDir, GENESIS_ANCHOR_RELATIVE_PATH);
  if (!existsSync(genesisPath)) {
    return {
      ok: false,
      code: 'GENESIS_ANCHOR_INVALID',
      detail: 'genesis anchor file absent',
    };
  }
  let raw;
  try {
    raw = readFileSync(genesisPath, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      code: 'GENESIS_ANCHOR_INVALID',
      detail: `genesis read failed: ${err && err.message}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      code: 'GENESIS_ANCHOR_INVALID',
      detail: `genesis JSON malformed: ${err && err.message}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'GENESIS_ANCHOR_INVALID',
      detail: 'genesis not a JSON object',
    };
  }
  if (parsed.seq !== 0) {
    return {
      ok: false,
      code: 'GENESIS_ANCHOR_INVALID',
      detail: `genesis.seq expected 0, got ${String(parsed.seq)}`,
    };
  }
  if (typeof parsed.hash !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.hash)) {
    return {
      ok: false,
      code: 'GENESIS_ANCHOR_INVALID',
      detail: 'genesis.hash must be 64-char lowercase hex SHA-256',
    };
  }
  if (typeof parsed.signed_by !== 'string' || parsed.signed_by.length === 0) {
    return {
      ok: false,
      code: 'GENESIS_ANCHOR_INVALID',
      detail: 'genesis.signed_by must be non-empty string',
    };
  }
  // Origin-chain content invariant: hash === SHA256("") when no prior rotation.
  // Rotation-chain anchors (previous_genesis_hash != null) use an operator-
  // minted hash; full rotation verification is as-018's concern.
  if (
    parsed.previous_genesis_hash === null &&
    parsed.hash !== EMPTY_STRING_SHA256
  ) {
    return {
      ok: false,
      code: 'GENESIS_ANCHOR_INVALID',
      detail: `origin genesis.hash must equal SHA256("") = ${EMPTY_STRING_SHA256}; got ${parsed.hash}`,
    };
  }
  return { ok: true };
}

/**
 * Record a test-writer unlock entry for a bug-fix-mode spec group.
 *
 * Sole-writer for `session.json.test_writer_unlock[<sg-id>]`. Preflight:
 *   1. Validate --dispatch-id + --first-failure-ref present and non-empty.
 *   2. Validate sg-id format.
 *   3. Read manifest.spec_mode; reject with UNLOCK_MODE_MISMATCH unless
 *      `spec_mode === 'bug-fix'` (AC-005.7, AC-3.2).
 *   4. Load session; require active_work (UNLOCK_SESSION_NO_ACTIVE_WORK).
 *   5. Read-or-bootstrap per-session HMAC secret (mode 0600).
 *   6. Compute first_failure_at (=now()) + unlocked_until (+5min).
 *   7. Mint marker via as-004 mintMarker() using (sgId, dispatchId,
 *      unlockedUntil, secret).
 *   8. Append audit entry event_class='test_writer_unlock' BEFORE session
 *      mutation (mirrors opOverrideEnforcement ordering). A failed append
 *      propagates AuditLogError → CLI exits 1 with UNLOCK_AUDIT_APPEND_FAILED
 *      and session.json is untouched (AC-005.10 / AC-005.8 invariant).
 *   9. Write session.active_work.test_writer_unlock[sgId] = { first_failure_at,
 *      unlocked_until, dispatch_id, marker } via saveSession (sole-writer
 *      path; existing FULL_BLOCK protects against non-checkpoint writers
 *      per AC-005.8).
 *
 * Acceptance criteria:
 *   - AC3.1: 4-field entry with unlocked_until = first_failure_at + 5min; exit 0
 *   - AC3.2: feature-mode rejects with UNLOCK_MODE_MISMATCH; session unchanged
 *   - AC3.3: direct-write blocked by existing FULL_BLOCK hook (not this handler)
 *   - AC3.4: completes <5s (no network IO, bounded local-fs work)
 *
 * @param {string} specGroupId     positional first arg
 * @param {string} dispatchId      --dispatch-id flag value
 * @param {string} firstFailureRef --first-failure-ref flag value
 */
export function opRecordTestWriterUnlock(specGroupId, dispatchId, firstFailureRef) {
  // ---- Preflight: argument shape -----------------------------------------
  if (!specGroupId) {
    throw new TestWriterUnlockError(
      'UNLOCK_USAGE_ERROR',
      'UNLOCK_USAGE_ERROR: Usage: record-test-writer-unlock <sg-id> --dispatch-id <id> --first-failure-ref <ref>'
    );
  }
  validateSpecGroupId(specGroupId);
  if (!dispatchId || typeof dispatchId !== 'string' || dispatchId.trim().length === 0) {
    throw new TestWriterUnlockError(
      'UNLOCK_USAGE_ERROR',
      'UNLOCK_USAGE_ERROR: --dispatch-id <id> is required and must be non-empty'
    );
  }
  if (!firstFailureRef || typeof firstFailureRef !== 'string' || firstFailureRef.trim().length === 0) {
    throw new TestWriterUnlockError(
      'UNLOCK_USAGE_ERROR',
      'UNLOCK_USAGE_ERROR: --first-failure-ref <ref> is required and must be non-empty'
    );
  }
  const trimmedDispatchId = dispatchId.trim();
  const trimmedFirstFailureRef = firstFailureRef.trim();

  // ---- Preflight: spec_mode gate (AC-005.7 / AC3.2) ----------------------
  const { specMode } = readManifestSpecMode(specGroupId);
  if (specMode !== 'bug-fix') {
    throw new TestWriterUnlockError(
      'UNLOCK_MODE_MISMATCH',
      `UNLOCK_MODE_MISMATCH: spec_group '${specGroupId}' has spec_mode='${specMode}'; ` +
        `record-test-writer-unlock requires spec_mode='bug-fix'. Hybrid-mode unlock is ` +
        `only permitted on bug-fix specs (REQ-005 fail-closed default, AC-005.7).`
    );
  }

  // ---- Preflight: session state ------------------------------------------
  const session = loadSession();
  if (!session) {
    throw new TestWriterUnlockError(
      'UNLOCK_SESSION_MISSING',
      'UNLOCK_SESSION_MISSING: No session.json exists. Run "init" first.'
    );
  }
  if (!session.active_work) {
    throw new TestWriterUnlockError(
      'UNLOCK_SESSION_NO_ACTIVE_WORK',
      'UNLOCK_SESSION_NO_ACTIVE_WORK: No active work. Run "start-work" before recording an unlock.'
    );
  }
  if (!session.session_id) {
    throw new TestWriterUnlockError(
      'UNLOCK_SESSION_MISSING',
      'UNLOCK_SESSION_MISSING: session.session_id missing; re-run `init` to repair session state.'
    );
  }

  // ---- HMAC secret read/bootstrap ----------------------------------------
  const secret = readOrBootstrapSessionHmacSecret(session.session_id);

  // ---- as-007 AC7.3: genesis-anchor content preflight --------------------
  // Fail-closed BEFORE any mutation if the hash-chain genesis anchor is
  // missing, malformed, or content-corrupted. This is stricter than the
  // shape check inside `appendAuditEntry` — we additionally require the
  // origin-chain invariant `genesis.hash === SHA256("")` when
  // `previous_genesis_hash === null` (the REQ-014 bootstrap anchor). A
  // shape-valid but content-corrupted genesis (e.g., hash replaced with a
  // well-formed but wrong 64-hex string) would otherwise slip past the
  // appender's hex-regex check and poison the chain.
  //
  // Detection at this point means: no session.json write, no audit entry,
  // CLI exits 2 with GENESIS_ANCHOR_INVALID. Operator must resolve the
  // genesis anchor before retry (no deferred-audit queue per spec Decision
  // Log 2026-04-22 inv-dep-6e2d4a).
  const genesisPreflight = verifyGenesisForUnlockPreflight(CLAUDE_DIR);
  if (!genesisPreflight.ok) {
    throw new TestWriterUnlockError(
      'GENESIS_ANCHOR_INVALID',
      `GENESIS_ANCHOR_INVALID: ${genesisPreflight.detail}. ` +
        `Unlock REJECTED — no session.json write, no audit entry. Operator must resolve ` +
        `.claude/audit/pipeline-efficiency-genesis.json before re-attempting the unlock.`,
      { underlying_code: genesisPreflight.code, detail: genesisPreflight.detail }
    );
  }

  // ---- Compute TTL window ------------------------------------------------
  // Spec §EC-WS2-6: TTL is anchored at first_failure_at at record time and
  // NOT re-computed per cooperative-check. now() is the canonical session
  // clock (wall clock UTC via `new Date().toISOString()`).
  const firstFailureAt = now();
  const unlockedUntilMs = Date.parse(firstFailureAt) + TEST_WRITER_UNLOCK_TTL_MS;
  const unlockedUntil = new Date(unlockedUntilMs).toISOString();

  // ---- Mint cryptographic marker (as-004) --------------------------------
  // Lazy-load to decouple as-003 from as-004 at module-load time (peer
  // atomic specs on parallel branches). globalThis stub path enables unit
  // tests to inject a deterministic mintMarker without touching the real
  // crypto module. Any load or mint failure propagates; main() catches and
  // exits 1 with no session mutation.
  const marker = _invokeMintMarker({
    specGroupId,
    dispatchId: trimmedDispatchId,
    unlockedUntil,
    secret,
  });

  // ---- Audit append BEFORE session mutation (AC-005.8 / AC-005.10) -------
  // Mirrors opOverrideEnforcement ordering: a failed audit append must never
  // leave session.json with an unlock entry that has no audit record.
  // event_class 'test_writer_unlock' is in the 9-class canonical enum
  // (audit-entry.schema.mjs EVENT_CLASSES).
  let auditSeq = null;
  try {
    const res = appendAuditEntry(
      'test_writer_unlock',
      'cli-record-unlock',
      {
        spec_group_id: specGroupId,
        dispatch_id: trimmedDispatchId,
        first_failure_ref: trimmedFirstFailureRef,
        first_failure_at: firstFailureAt,
        unlocked_until: unlockedUntil,
        operator_or_agent: process.env.USER || 'agent',
      },
      { timestamp: firstFailureAt }
    );
    auditSeq = res.seq;
  } catch (err) {
    // as-007 AC7.3: fail-closed rejection when the hash-chain genesis anchor
    // is missing / invalid. Surface `GENESIS_ANCHOR_INVALID` so the CLI exits
    // 2 and the stderr token matches the spec-defined operator signal.
    // Remaining chain errors (E_LOG_LINE_*, E_WRITE_FAILED, schema) bubble up
    // as UNLOCK_AUDIT_APPEND_FAILED with exit 1 (preserving existing behavior).
    // Session.json mutation has NOT happened yet — audit runs BEFORE saveSession
    // per opOverrideEnforcement ordering — so fail-closed requires no rollback.
    const underlyingCode = err && err.code ? err.code : 'UNKNOWN';
    const GENESIS_ERROR_CODES = new Set([
      'E_GENESIS_ANCHOR_MISSING',
      'E_GENESIS_ANCHOR_INVALID',
      'E_GENESIS_HASH_INVALID',
    ]);
    if (GENESIS_ERROR_CODES.has(underlyingCode)) {
      throw new TestWriterUnlockError(
        'GENESIS_ANCHOR_INVALID',
        `GENESIS_ANCHOR_INVALID: hash-chain genesis anchor is missing or invalid (underlying=${underlyingCode}): ${err && err.message}. ` +
          `Unlock REJECTED — no session.json write, no audit entry. Operator must resolve ` +
          `.claude/audit/pipeline-efficiency-genesis.json before re-attempting the unlock.`,
        { underlying_code: underlyingCode }
      );
    }
    throw new TestWriterUnlockError(
      'UNLOCK_AUDIT_APPEND_FAILED',
      `UNLOCK_AUDIT_APPEND_FAILED: audit chain append failed (underlying=${underlyingCode}): ${err && err.message}`,
      { underlying_code: underlyingCode }
    );
  }

  // ---- Session mutation via sole-writer saveSession ----------------------
  // test_writer_unlock is a per-spec-group-id map stored under active_work
  // so its lifetime is bounded by the active-work entry (auto-cleanup on
  // complete-work / archive-incomplete per EC-WS2-8). Key is the sg-id;
  // value is the 4-field entry per TestWriterUnlockEntry contract.
  if (!session.active_work.test_writer_unlock || typeof session.active_work.test_writer_unlock !== 'object') {
    session.active_work.test_writer_unlock = {};
  }
  session.active_work.test_writer_unlock[specGroupId] = {
    first_failure_at: firstFailureAt,
    unlocked_until: unlockedUntil,
    dispatch_id: trimmedDispatchId,
    marker,
  };

  // Session history breadcrumb (distinct from hash-chained audit log).
  addHistoryEntry(session, 'test_writer_unlock_recorded', {
    spec_group_id: specGroupId,
    dispatch_id: trimmedDispatchId,
    first_failure_ref: trimmedFirstFailureRef,
    unlocked_until: unlockedUntil,
    audit_seq: auditSeq,
  });

  saveSession(session);

  // Structured JSON on stdout so scripts / tests can parse; human-readable
  // line on stderr so operators see the result in their terminal.
  const out = {
    ok: true,
    spec_group_id: specGroupId,
    first_failure_at: firstFailureAt,
    unlocked_until: unlockedUntil,
    dispatch_id: trimmedDispatchId,
    audit_seq: auditSeq,
  };
  console.log(JSON.stringify(out));
  console.error(
    `test-writer-unlock recorded: ${specGroupId} unlocked_until=${unlockedUntil} dispatch_id=${trimmedDispatchId}`
  );
}

// =============================================================================
// as-007 audit emission helpers (consumed by as-005 predicate + as-008 stop-hook)
// =============================================================================
//
// These helpers centralize the payload shape for the three test-writer-unlock
// event classes so the emission sites stay consistent with the Audit log entry
// shape contract (spec.md § Interfaces & Contracts § Audit log entry shape).
//
// AC7.1 (test_writer_unlock) — already wired inline inside opRecordTestWriterUnlock
//        above; the helper is not used there to keep the as-003 success path
//        atomic with the session.json write. The shape matches this helper's
//        test_writer_unlock_refence / test_writer_unlock_misuse payloads by
//        design (seq, prev_hash, timestamp, event_class are added by the
//        appendAuditEntry chain helper itself).
// AC7.2 (test_writer_unlock_refence) — consumed by as-005 5-trigger predicate.
// Task 7.4 (test_writer_unlock_misuse) — consumed by as-008 stop-hook.
//
// All three event classes are in the 9-class canonical enum (see
// lib/schemas/audit-entry.schema.mjs EVENT_CLASSES). Genesis / chain errors
// surface as AuditLogError with codes E_GENESIS_ANCHOR_{MISSING,INVALID} /
// E_GENESIS_HASH_INVALID / E_WRITE_FAILED — call sites must decide whether
// to fail-closed (as-003 reject path, AC7.3) or log-and-continue (as-008
// misuse heartbeat is non-blocking advisory per AC-005.9).

/**
 * Canonical set of re-fence trigger labels (spec.md § AC-005.6).
 *
 * `session-end` covers both `archive-incomplete` and `complete-work` entry
 * points per Task 5.2; as-005 is responsible for narrowing to the specific
 * source at the call site.
 */
export const REFENCE_TRIGGERS = Object.freeze([
  'spec-complete',
  'test-pass',
  'version-bump',
  'workstream-rotate',
  'session-end',
]);

/**
 * Emit a `test_writer_unlock_refence` audit entry (AC7.2).
 *
 * Called by the as-005 re-fence predicate after it clears
 * `session.json.active_work.test_writer_unlock[<sg-id>]` via the sole-writer
 * path. The `trigger` field identifies which of 5 events fired.
 *
 * Ordering invariant (mirrors opRecordTestWriterUnlock): predicate call sites
 * SHOULD run this before the sole-writer clear, or SHOULD tolerate an audit
 * append failure by keeping the in-memory unlock cleared (the next dispatch
 * will fail-closed regardless). Concrete ordering is a predicate-level choice
 * in as-005 — this helper only enforces payload shape + event-class.
 *
 * @param {object} args
 * @param {string} args.specGroupId    spec-group-id whose unlock is being cleared
 * @param {(typeof REFENCE_TRIGGERS)[number]} args.trigger  re-fence trigger label
 * @param {string} [args.dispatchId]   dispatch-id of the unlock being cleared (if known)
 * @param {string} [args.firstFailureRef]  first-failure-ref of the cleared unlock (if known)
 * @param {string} [args.unlockedUntil] TTL timestamp of the cleared unlock (if known)
 * @param {string} [args.actor]        'operator' | 'agent' (default: 'agent')
 * @param {string} [args.timestamp]    ISO-8601 UTC override (for tests)
 * @returns {{ seq: number, logPath: string, entry: Record<string, unknown> }}
 * @throws {AuditLogError} propagated from appendAuditEntry; call site decides
 *                         whether to fail-closed or log-and-continue.
 */
export function emitTestWriterUnlockRefence(args) {
  if (!args || typeof args !== 'object') {
    throw new Error('emitTestWriterUnlockRefence: args object required');
  }
  const { specGroupId, trigger, dispatchId, firstFailureRef, unlockedUntil, actor, timestamp } = args;
  if (!specGroupId || typeof specGroupId !== 'string') {
    throw new Error('emitTestWriterUnlockRefence: specGroupId must be a non-empty string');
  }
  if (!REFENCE_TRIGGERS.includes(trigger)) {
    throw new Error(
      `emitTestWriterUnlockRefence: trigger must be one of ${REFENCE_TRIGGERS.join(', ')}; got '${trigger}'`
    );
  }
  const payload = {
    spec_group_id: specGroupId,
    trigger,
    operator_or_agent: process.env.USER || 'agent',
  };
  if (dispatchId) payload.dispatch_id = dispatchId;
  if (firstFailureRef) payload.first_failure_ref = firstFailureRef;
  if (unlockedUntil) payload.unlocked_until = unlockedUntil;

  const options = {};
  if (actor) options.actor = actor;
  if (timestamp) options.timestamp = timestamp;

  return appendAuditEntry('test_writer_unlock_refence', `refence-${trigger}`, payload, options);
}

/**
 * Emit a `test_writer_unlock_misuse` audit entry (Task 7.4; AC-005.9).
 *
 * Consumed by the as-008 stop-hook when a test-writer dispatch completes
 * inside an active unlock TTL window WITHOUT creating or modifying test
 * files. The emission is ADVISORY — call sites should log-and-continue on
 * AuditLogError (test-writer dispatch MUST NOT be blocked per AC-005.9).
 *
 * This helper defines the contract shape so as-008 can consume it without
 * needing to hand-assemble the payload. `dispatch_id` and `first_failure_ref`
 * are REQUIRED here (unlike refence) because the stop-hook always has them
 * in scope from the just-completed dispatch.
 *
 * @param {object} args
 * @param {string} args.specGroupId      spec-group-id whose unlock was active
 * @param {string} args.dispatchId       dispatch-id of the just-completed dispatch
 * @param {string} args.firstFailureRef  first-failure-ref from the active unlock
 * @param {string} [args.reason]         human-readable misuse subtype (default 'no-new-tests')
 * @param {string} [args.actor]          'operator' | 'agent' (default: 'agent')
 * @param {string} [args.timestamp]      ISO-8601 UTC override (for tests)
 * @returns {{ seq: number, logPath: string, entry: Record<string, unknown> }}
 * @throws {AuditLogError} propagated from appendAuditEntry; as-008 must
 *                         log-and-continue (advisory, non-blocking).
 */
export function emitTestWriterUnlockMisuse(args) {
  if (!args || typeof args !== 'object') {
    throw new Error('emitTestWriterUnlockMisuse: args object required');
  }
  const { specGroupId, dispatchId, firstFailureRef, reason, actor, timestamp } = args;
  if (!specGroupId || typeof specGroupId !== 'string') {
    throw new Error('emitTestWriterUnlockMisuse: specGroupId must be a non-empty string');
  }
  if (!dispatchId || typeof dispatchId !== 'string') {
    throw new Error('emitTestWriterUnlockMisuse: dispatchId must be a non-empty string');
  }
  if (!firstFailureRef || typeof firstFailureRef !== 'string') {
    throw new Error('emitTestWriterUnlockMisuse: firstFailureRef must be a non-empty string');
  }
  const subtype = reason && typeof reason === 'string' && reason.trim().length > 0
    ? reason.trim()
    : 'no-new-tests';
  const payload = {
    spec_group_id: specGroupId,
    dispatch_id: dispatchId,
    first_failure_ref: firstFailureRef,
    reason: subtype,
    operator_or_agent: process.env.USER || 'agent',
  };
  const options = {};
  if (actor) options.actor = actor;
  if (timestamp) options.timestamp = timestamp;

  return appendAuditEntry('test_writer_unlock_misuse', `misuse-${subtype}`, payload, options);
}

// =============================================================================
// sg-pipeline-efficiency-ws2-practice-2.4 / as-005 / REQ-005 (AC-005.6)
// 5-trigger re-fence predicate — clears `test_writer_unlock[<sg-id>]` when
// any of 5 session lifecycle events fires for that spec-group-id. Runs inside
// the sole-writer `session-checkpoint.mjs` boundary so concurrent triggers do
// not race (design-doc §4.2, Q2 resolution).
// =============================================================================

/**
 * Evaluate the 5-trigger re-fence predicate for a spec-group-id within a live
 * session object. Idempotent: a no-op when the unlock entry is absent.
 *
 * Callers MUST be holding the session-save transaction (i.e., already inside
 * an `op*` that will call `saveSession` afterward). The predicate mutates
 * `session` in place and appends a `test_writer_unlock_refence` audit entry
 * via `emitTestWriterUnlockRefence` (as-007 helper, AC7.2) BEFORE the session
 * mutation is visible to subsequent readers. Mirrors the ordering used by
 * `opRecordTestWriterUnlock` so a failed audit append never leaves
 * session.json in an inconsistent "cleared without audit record" state.
 *
 * Sole-writer path: the only clear site for
 * `session.active_work.test_writer_unlock[<sg-id>]` is this function.
 * Session-end callers (opCompleteWork / opArchiveIncomplete) route through
 * `evaluateRefenceTriggerForAllUnlocks` before the broader active_work wipe.
 *
 * @param {object} session      loaded session (mutated in place on match)
 * @param {string} specGroupId  non-empty sg-id
 * @param {(typeof REFENCE_TRIGGERS)[number]} trigger  one of 5 canonical labels
 * @returns {{cleared: boolean, trigger: string|null, auditSeq: number|null}}
 *          cleared=true iff an entry existed and was removed + audit-logged;
 *          cleared=false on idempotent no-op (AC5.3, AC5.4).
 */
export function evaluateRefenceTrigger(session, specGroupId, trigger) {
  if (!session || typeof session !== 'object') {
    throw new TestWriterUnlockError(
      'REFENCE_USAGE_ERROR',
      'REFENCE_USAGE_ERROR: session object is required'
    );
  }
  if (!specGroupId || typeof specGroupId !== 'string') {
    throw new TestWriterUnlockError(
      'REFENCE_USAGE_ERROR',
      'REFENCE_USAGE_ERROR: specGroupId must be a non-empty string'
    );
  }
  if (!REFENCE_TRIGGERS.includes(trigger)) {
    throw new TestWriterUnlockError(
      'REFENCE_TRIGGER_INVALID',
      `REFENCE_TRIGGER_INVALID: trigger '${trigger}' not in canonical enum ` +
        `{${REFENCE_TRIGGERS.join(', ')}}. See design-doc §4.1.`
    );
  }

  // AC5.3 idempotency: no active_work → no unlock map → no-op. The
  // complete-work / archive-incomplete code paths run the predicate BEFORE
  // nulling active_work, so this branch catches concurrency edge-cases
  // (e.g., session loaded after active_work wipe) rather than the normal
  // session-end flow.
  const activeWork = session.active_work;
  if (!activeWork || typeof activeWork !== 'object') {
    return { cleared: false, trigger: null, auditSeq: null };
  }
  const unlockMap = activeWork.test_writer_unlock;
  if (!unlockMap || typeof unlockMap !== 'object') {
    return { cleared: false, trigger: null, auditSeq: null };
  }
  const entry = unlockMap[specGroupId];
  if (!entry || typeof entry !== 'object') {
    return { cleared: false, trigger: null, auditSeq: null };
  }

  // Snapshot the pre-clear fields so the audit payload carries the bound
  // dispatch_id / unlocked_until even though we're about to wipe the entry.
  // `first_failure_ref` is not part of the stored entry (record-time input
  // to mintMarker); omit from the re-fence payload per design-doc §7.1.
  const priorDispatchId = typeof entry.dispatch_id === 'string' ? entry.dispatch_id : undefined;
  const priorUnlockedUntil = typeof entry.unlocked_until === 'string' ? entry.unlocked_until : undefined;

  // AC5.1 / AC-005.10: audit append BEFORE session mutation via the as-007
  // helper. A failed append throws (AuditLogError wrapping
  // GENESIS_ANCHOR_INVALID / CHAIN_BROKEN / E_WRITE_FAILED) and leaves the
  // unlock entry intact so the caller can retry once the chain is repaired.
  // Mirror opRecordTestWriterUnlock's ordering verbatim.
  const timestamp = now();
  let auditSeq = null;
  try {
    const res = emitTestWriterUnlockRefence({
      specGroupId,
      trigger,
      dispatchId: priorDispatchId,
      unlockedUntil: priorUnlockedUntil,
      timestamp,
    });
    auditSeq = res.seq;
  } catch (err) {
    const underlyingCode = err && err.code ? err.code : 'UNKNOWN';
    throw new TestWriterUnlockError(
      'REFENCE_AUDIT_APPEND_FAILED',
      `REFENCE_AUDIT_APPEND_FAILED: audit chain append failed ` +
        `(underlying=${underlyingCode}) for trigger=${trigger} sg=${specGroupId}: ` +
        `${err && err.message}`,
      { underlying_code: underlyingCode, trigger, spec_group_id: specGroupId }
    );
  }

  // AC5.1: clear entry via sole-writer path (in-place mutation; caller
  // `saveSession`s within the same transaction). Delete the key rather than
  // assigning `null` so readers see the canonical "absent" shape used by
  // the initial Fenced state (design-doc §2.1).
  delete unlockMap[specGroupId];

  // Session history breadcrumb mirrors `test_writer_unlock_recorded` so
  // `get-status` surfaces the clear without depending on the hash-chain.
  addHistoryEntry(session, 'test_writer_unlock_refence', {
    spec_group_id: specGroupId,
    trigger,
    dispatch_id: priorDispatchId || null,
    unlocked_until: priorUnlockedUntil || null,
    audit_seq: auditSeq,
  });

  return { cleared: true, trigger, auditSeq };
}

/**
 * Evaluate re-fence for every unlock entry currently held by active_work
 * under a given trigger label. Used by session-end triggers (archive-
 * incomplete, complete-work) that must clear ALL live unlocks regardless
 * of sg-id. Each matched entry produces a separate audit entry so the
 * chain records one clear per spec-group-id (design-doc §4.3).
 *
 * @param {object} session loaded session (mutated in place)
 * @param {(typeof REFENCE_TRIGGERS)[number]} trigger
 * @returns {Array<{spec_group_id: string, audit_seq: number|null}>} cleared entries
 */
export function evaluateRefenceTriggerForAllUnlocks(session, trigger) {
  const cleared = [];
  const activeWork = session && session.active_work;
  if (!activeWork || typeof activeWork !== 'object') return cleared;
  const unlockMap = activeWork.test_writer_unlock;
  if (!unlockMap || typeof unlockMap !== 'object') return cleared;
  // Snapshot keys before mutation — evaluateRefenceTrigger deletes entries
  // from unlockMap, which would invalidate a live Object.keys iteration.
  const sgIds = Object.keys(unlockMap);
  for (const sgId of sgIds) {
    const res = evaluateRefenceTrigger(session, sgId, trigger);
    if (res.cleared) cleared.push({ spec_group_id: sgId, audit_seq: res.auditSeq });
  }
  return cleared;
}

/**
 * fire-refence-trigger CLI — external-signal entry point for the
 * `version-bump` and `workstream-rotate` triggers. `spec-complete`,
 * `test-pass`, and `session-end` fire internally from their owning op*
 * functions (opTransitionPhase, opUpdateConvergence, opCompleteWork /
 * opArchiveIncomplete) so the predicate runs inside the same session-save
 * transaction as the trigger's primary effect (Q2 resolution, design-doc §4.2).
 *
 * Callers (version-bump detector, facilitator rotation hook) invoke this CLI
 * with the sg-id and trigger label; the predicate runs against the loaded
 * session and persists via `saveSession`. Idempotent — returns exit 0 even
 * when no unlock exists for the sg-id (AC5.3).
 *
 * Usage: fire-refence-trigger <sg-id> --trigger <label>
 */
function opFireRefenceTrigger(specGroupId, trigger) {
  if (!specGroupId) {
    throw new TestWriterUnlockError(
      'REFENCE_USAGE_ERROR',
      'REFENCE_USAGE_ERROR: Usage: fire-refence-trigger <sg-id> --trigger <label>'
    );
  }
  validateSpecGroupId(specGroupId);
  if (!trigger) {
    throw new TestWriterUnlockError(
      'REFENCE_USAGE_ERROR',
      `REFENCE_USAGE_ERROR: --trigger <label> is required (one of ${REFENCE_TRIGGERS.join(', ')})`
    );
  }
  if (!REFENCE_TRIGGERS.includes(trigger)) {
    throw new TestWriterUnlockError(
      'REFENCE_TRIGGER_INVALID',
      `REFENCE_TRIGGER_INVALID: trigger '${trigger}' not in canonical enum ` +
        `{${REFENCE_TRIGGERS.join(', ')}}`
    );
  }

  const session = loadSession();
  if (!session) {
    throw new TestWriterUnlockError(
      'REFENCE_SESSION_MISSING',
      'REFENCE_SESSION_MISSING: No session.json exists. Run "init" first.'
    );
  }

  const result = evaluateRefenceTrigger(session, specGroupId, trigger);

  if (result.cleared) {
    saveSession(session);
    const out = {
      ok: true,
      cleared: true,
      spec_group_id: specGroupId,
      trigger,
      audit_seq: result.auditSeq,
    };
    console.log(JSON.stringify(out));
    console.error(
      `test-writer-unlock re-fenced: ${specGroupId} trigger=${trigger} audit_seq=${result.auditSeq}`
    );
  } else {
    // Idempotent no-op — still exit 0 with structured json so callers can
    // distinguish "no unlock present" from "unlock cleared".
    const out = {
      ok: true,
      cleared: false,
      spec_group_id: specGroupId,
      trigger,
      audit_seq: null,
    };
    console.log(JSON.stringify(out));
    console.error(
      `test-writer-unlock re-fence no-op: ${specGroupId} trigger=${trigger} (no entry)`
    );
  }
}

// =============================================================================
// Routing decision persistence.
// record-route-decision CLI (sole-writer for session.active_work.route_decisions[])
// =============================================================================

/**
 * Maximum length (in characters) for `rationale_excerpt` per OQ-105.
 * Keeps the append-only log lightweight and avoids embedding full request
 * text (which may contain sensitive project context).
 */
const ROUTE_DECISION_RATIONALE_MAX_CHARS = 120;

/**
 * Concurrency retry budget for record-route-decision writes.
 *
 * The shared `acquireLock()` primitive only retries once after 100ms (per
 * REQ-034); record-route-decision is advisory instrumentation that can
 * legitimately be invoked multiple times in close succession (e.g., a test
 * harness firing 3 parallel calls, or a reroute chain). Wrapping
 * `atomicModifyJSON` with a short retry loop serializes concurrent writers
 * without reaching into session-lock internals.
 */
const ROUTE_DECISION_WRITE_MAX_RETRIES = 8;
const ROUTE_DECISION_WRITE_RETRY_BASE_MS = 50;

/**
 * Resolve the session.json path for the record-route-decision op.
 *
 * Honors `CLAUDE_PROJECT_DIR` env var so test harnesses (and hook callers)
 * can redirect writes to an isolated tmp dir. Falls back to the module-level
 * `SESSION_PATH` (computed from `findClaudeDir()`) when the env var is
 * absent — preserves the module's default behavior for non-test callers.
 *
 * Security (sec-path-7b3a91c2 / NFR-WORKTREE-CANON):
 *   The env root is routed through `canonicalize()` (symlink-component reject
 *   + realpath resolution) before the session path is materialized. When the
 *   live session carries a pinned worktree root (`active_work.project_dir_pin`),
 *   `validateAgainstPin()` asserts the canonicalized env root is contained
 *   within the pin — raising WorktreePathViolationError on escape. This closes
 *   the symlink-escape and pin-bypass surface that was originally shipped in
 *   ws-3 for other canon consumers (workflow-gate-enforcement, workflow-file-
 *   protection). Callers that want env-parity (mid-session mutation detection)
 *   invoke `enforceEnvParity(pin)` separately — see `opRecordRouteDecision`.
 *
 * @param {object|null} [session] — live session (used for pin lookup). When
 *   omitted, no pin validation runs (matches `enforceEnvParity` legacy-session
 *   guard — zero-regression for sessions predating as-006 pin capture).
 * @returns {string} absolute path to session.json
 * @throws {WorktreePathViolationError} on symlink-component or pin escape.
 */
function resolveRouteDecisionSessionPath(session) {
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  if (envRoot && typeof envRoot === 'string' && envRoot.length > 0) {
    const pin =
      session && session.active_work && typeof session.active_work === 'object'
        ? session.active_work.project_dir_pin
        : null;

    // Legacy-session guard (sec-path-7b3a91c2 / as-008 parity): when pin is
    // absent (null/undefined), skip canon enforcement. Matches the zero-
    // regression contract for sessions predating as-006 pin capture that
    // `validateAgainstPin` and `enforceEnvParity` already honor — this
    // function must not be stricter than its collaborators.
    if (!pin || typeof pin !== 'string' || pin.length === 0) {
      return join(envRoot, '.claude', 'context', 'session.json');
    }

    // Pin present → full canon pipeline: symlink-component reject + realpath
    // resolution, then pin-containment check. Mirrors ws-3 SEC H2 closure
    // pattern. Throws WorktreePathViolationError on reject.
    const resolved = canonicalize(envRoot);
    validateAgainstPin(resolved, pin);
    return join(resolved, '.claude', 'context', 'session.json');
  }
  return SESSION_PATH;
}

/**
 * Sleep synchronously for `ms` milliseconds. Used between
 * atomicModifyJSON retry attempts so concurrent writers do not burn CPU.
 *
 * @param {number} ms
 */
function syncSleepMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Truncate a rationale string to the documented maximum, preserving prefix
 * semantics (the informational part stays; we trim from the end).
 *
 * @param {string} s
 * @returns {string}
 */
function truncateRationale(s) {
  if (s.length <= ROUTE_DECISION_RATIONALE_MAX_CHARS) return s;
  return s.slice(0, ROUTE_DECISION_RATIONALE_MAX_CHARS);
}

/**
 * Validate the `multi_domain_justification` shape.
 *
 * Contract (ROUTING.md routing-decision persistence):
 *   - Array of `{criterion: string, evidence: string}` objects.
 *   - Required when workflow === 'orchestrator'; forbidden otherwise.
 *   - Each element must have non-empty `criterion` AND non-empty `evidence`.
 *   - Requires two or more entries.
 *
 * Returns the validated array on success; throws RouteDecisionError on
 * failure with a code describing which validation layer fired.
 *
 * @param {string} workflow — validated workflow enum value
 * @param {string|null} rawJson — raw `--multi-domain-justification` value
 * @returns {Array<{criterion: string, evidence: string}>|null}
 */
function validateMultiDomainJustification(workflow, rawJson) {
  const isOrchestrator = workflow === 'orchestrator';

  if (rawJson === null || rawJson === undefined) {
    if (isOrchestrator) {
      throw new RouteDecisionError(
        'ROUTE_DECISION_JUSTIFICATION_REQUIRED',
        'ROUTE_DECISION_JUSTIFICATION_REQUIRED: --multi-domain-justification ' +
          'is required when workflow=orchestrator (REQ-003). Supply a JSON ' +
        'array of {criterion, evidence} objects with at least two entries.'
      );
    }
    return null;
  }

  // Non-orchestrator with justification — reject to keep the log tidy.
  if (!isOrchestrator) {
    throw new RouteDecisionError(
      'ROUTE_DECISION_JUSTIFICATION_FORBIDDEN',
      `ROUTE_DECISION_JUSTIFICATION_FORBIDDEN: --multi-domain-justification ` +
        `is only permitted when workflow=orchestrator (got workflow=${workflow}).`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new RouteDecisionError(
      'ROUTE_DECISION_JUSTIFICATION_INVALID',
      `ROUTE_DECISION_JUSTIFICATION_INVALID: --multi-domain-justification ` +
        `is not valid JSON: ${err.message}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new RouteDecisionError(
      'ROUTE_DECISION_JUSTIFICATION_INVALID',
      'ROUTE_DECISION_JUSTIFICATION_INVALID: --multi-domain-justification ' +
        'must be a JSON array of {criterion, evidence} objects.'
    );
  }

  if (parsed.length < 2) {
    throw new RouteDecisionError(
      'ROUTE_DECISION_JUSTIFICATION_INVALID',
      `ROUTE_DECISION_JUSTIFICATION_INVALID: --multi-domain-justification ` +
        `must enumerate at least two criteria (REQ-003); got ${parsed.length}.`
    );
  }

  const validated = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RouteDecisionError(
        'ROUTE_DECISION_JUSTIFICATION_INVALID',
        `ROUTE_DECISION_JUSTIFICATION_INVALID: entry [${i}] is not an object.`
      );
    }
    const { criterion, evidence } = entry;
    if (typeof criterion !== 'string' || criterion.trim().length === 0) {
      throw new RouteDecisionError(
        'ROUTE_DECISION_JUSTIFICATION_INVALID',
        `ROUTE_DECISION_JUSTIFICATION_INVALID: entry [${i}].criterion must be a non-empty string.`
      );
    }
    if (typeof evidence !== 'string' || evidence.trim().length === 0) {
      throw new RouteDecisionError(
        'ROUTE_DECISION_JUSTIFICATION_INVALID',
        `ROUTE_DECISION_JUSTIFICATION_INVALID: entry [${i}].evidence must be a non-empty string.`
      );
    }
    validated.push({ criterion: criterion.trim(), evidence: evidence.trim() });
  }

  return validated;
}

/**
 * Validate an optional route risk tier.
 *
 * @param {string|null} rawRiskTier
 * @returns {string|null}
 */
function validateRouteRiskTier(rawRiskTier) {
  if (rawRiskTier === null || rawRiskTier === undefined) return null;
  if (!VALID_RISK_TIERS.includes(rawRiskTier)) {
    throw new RouteDecisionError(
      'ROUTE_DECISION_RISK_TIER_INVALID',
      `ROUTE_DECISION_RISK_TIER_INVALID: risk_tier='${rawRiskTier}' is not in the ` +
        `valid set [${VALID_RISK_TIERS.join(', ')}].`
    );
  }
  return rawRiskTier;
}

/**
 * record-route-decision — append a routing decision to the session's
 * append-only log.
 *
 * Sole-writer for `session.active_work.route_decisions[]`. Called by the
 * main-agent after `/route` produces its decision block, before the next
 * phase transition.
 *
 * Uses `atomicModifyJSON` (and its internal `acquireLock`/`releaseLock`)
 * so concurrent writers cannot corrupt session.json. An audit entry is
 * emitted on successful write via `appendAuditEntry` (event_class
 * `session_checkpoint`, subtype `record-route-decision`).
 *
 * Behavior:
 *   1. Validate workflow against VALID_WORKFLOWS (reuse of session-level enum).
 *   2. Validate rationale (non-empty string; truncated to 120 chars per OQ-105).
 *   3. Validate multi-domain-justification JSON:
 *        - Required for orchestrator (ROUTE_DECISION_JUSTIFICATION_REQUIRED).
 *        - Forbidden for non-orchestrator (ROUTE_DECISION_JUSTIFICATION_FORBIDDEN).
 *        - ≥2 entries with {criterion, evidence} non-empty strings.
 *   4. Validate optional risk_tier route metadata.
 *   5. Append entry to session.active_work.route_decisions[]
 *      (create the array on first write).
 *   6. Store risk_tier on active_work when provided.
 *   7. Emit audit entry (best-effort; audit failure logged but not fatal —
 *      this CLI is advisory instrumentation, not a quality-gate).
 *   8. Print structured JSON to stdout, human-readable line to stderr.
 *
 * Exit codes (handled by main()):
 *   0  on success
 *   1  on validation errors (ROUTE_DECISION_* codes)
 *   1  on session-lock or write failure
 *
 * @param {string} workflow         positional arg 1 — workflow enum value
 * @param {string} rationale        positional arg 2 — rationale excerpt
 * @param {string|null} rawJustification optional --multi-domain-justification
 *                                       raw JSON string
 * @param {string|null} rawRiskTier optional --risk-tier value
 */
export function opRecordRouteDecision(
  workflow,
  rationale,
  rawJustification,
  rawRiskTier = null,
) {
  // ---- Preflight: argument shape -----------------------------------------
  if (typeof workflow !== 'string' || workflow.length === 0) {
    throw new RouteDecisionError(
      'ROUTE_DECISION_USAGE_ERROR',
      'ROUTE_DECISION_USAGE_ERROR: Usage: record-route-decision <workflow> <rationale> ' +
        '[--risk-tier <tier>] [--multi-domain-justification <json>]'
    );
  }
  if (!VALID_WORKFLOWS.includes(workflow)) {
    throw new RouteDecisionError(
      'ROUTE_DECISION_WORKFLOW_INVALID',
      `ROUTE_DECISION_WORKFLOW_INVALID: workflow='${workflow}' is not in the ` +
        `valid set [${VALID_WORKFLOWS.join(', ')}].`
    );
  }
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    throw new RouteDecisionError(
      'ROUTE_DECISION_RATIONALE_INVALID',
      'ROUTE_DECISION_RATIONALE_INVALID: <rationale> is required and must be a non-empty string.'
    );
  }

  const justification = validateMultiDomainJustification(workflow, rawJustification);
  const riskTier = validateRouteRiskTier(rawRiskTier);

  // ---- Worktree-canon enforcement (sec-path-7b3a91c2 / NFR-WORKTREE-CANON) ----
  //
  // Before any session-path resolution or write, route the env root through
  // the canon library:
  //   1. Load the live session (read-only) to discover
  //      `active_work.project_dir_pin` — the pinned worktree root captured
  //      at start-work (as-006).
  //   2. `enforceEnvParity(pin)` asserts the current CLAUDE_PROJECT_DIR
  //      canonicalizes to the same path (symlink-component reject + case-
  //      insensitive FS dispatch). Mid-session env mutation → exit 2.
  //   3. `resolveRouteDecisionSessionPath(session)` performs the
  //      containment check against the pin via `validateAgainstPin`.
  //
  // Legacy-session guard: when pin is absent (null/undefined), both
  // `enforceEnvParity` and `validateAgainstPin` are no-ops (preserved by the
  // canon library itself per as-008). This preserves zero-regression behavior
  // for sessions predating pin capture.
  //
  // On violation: emit structured stderr (matching the canon consumer
  // convention used in workflow-gate-enforcement.mjs) + audit entry + exit 2.
  //
  // Load the session to discover `active_work.project_dir_pin`. We read
  // from the env-scoped session.json (CLAUDE_PROJECT_DIR-aware) rather than
  // `SESSION_PATH`, because this CLI honors the env var for test / hook
  // isolation — and the pin lookup must target the same session we would
  // subsequently write to. If the session file is absent or corrupt, the
  // loader returns null and enforcement falls through (legacy-session guard
  // — this CLI is advisory instrumentation and must not block on transient
  // session-file issues).
  let canonSession = null;
  try {
    const envRoot = process.env.CLAUDE_PROJECT_DIR;
    const sessionReadPath =
      envRoot && typeof envRoot === 'string' && envRoot.length > 0
        ? join(envRoot, '.claude', 'context', 'session.json')
        : SESSION_PATH;
    if (existsSync(sessionReadPath)) {
      const raw = readFileSync(sessionReadPath, 'utf-8');
      canonSession = JSON.parse(raw);
    }
  } catch {
    canonSession = null;
  }
  const canonPin =
    canonSession &&
    canonSession.active_work &&
    typeof canonSession.active_work === 'object'
      ? canonSession.active_work.project_dir_pin
      : null;

  let routeDecisionSessionPath;
  try {
    if (canonPin && typeof canonPin === 'string' && canonPin.length > 0) {
      // Step 1: env-parity — detect mid-session CLAUDE_PROJECT_DIR mutation.
      enforceEnvParity(canonPin);
    }
    // Step 2: resolve path with pin-containment (validateAgainstPin inside).
    routeDecisionSessionPath = resolveRouteDecisionSessionPath(canonSession);
  } catch (canonErr) {
    if (canonErr instanceof WorktreePathViolationError) {
      const reason = canonErr.reason || 'unknown';
      const attemptedPath =
        canonErr.attempted_path || process.env.CLAUDE_PROJECT_DIR || '<unset>';
      const pinnedRoot = canonErr.pinned_root || canonPin || '<unknown>';
      const code = canonErr.code || WORKTREE_PATH_VIOLATION;

      // Audit append (best-effort; advisory path — audit failure must not
      // mask the enforcement decision). Event class is the canonical
      // `worktree_path_violation` fixed by the shared helper.
      (async () => {
        try {
          const { appendWorktreeAuditEntry } = await import(
            './lib/worktree-enforcement.mjs'
          );
          await appendWorktreeAuditEntry(reason, {
            attempted_path: attemptedPath,
            pinned_root: pinnedRoot,
            consumer: 'session-checkpoint:record-route-decision',
            hook: 'session-checkpoint',
            op: 'record-route-decision',
            session_id:
              canonSession && typeof canonSession.session_id === 'string'
                ? canonSession.session_id
                : null,
          }, { projectRoot: pinnedRoot });
        } catch {
          // Silent — audit-log unavailability MUST NOT block enforcement.
        }
      })();

      // Structured stderr block (matches workflow-gate-enforcement.mjs
      // convention: code / reason / attempted_path / pinned_root / exit_code).
      process.stderr.write('\n');
      process.stderr.write('========================================\n');
      process.stderr.write('BLOCKED: WORKTREE_PATH_VIOLATION\n');
      process.stderr.write('========================================\n');
      process.stderr.write('\n');
      process.stderr.write(`code:           ${code}\n`);
      process.stderr.write(`reason:         ${reason}\n`);
      process.stderr.write(`attempted_path: ${attemptedPath}\n`);
      process.stderr.write(`pinned_root:    ${pinnedRoot}\n`);
      process.stderr.write(`exit_code:      2\n`);
      process.stderr.write('\n');
      process.stderr.write(
        'CLAUDE_PROJECT_DIR does not canonicalize within session.active_work.project_dir_pin.\n'
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
    // Non-violation error (e.g., TypeError from a malformed pin shape):
    // rethrow so the surrounding CLI dispatcher surfaces it.
    throw canonErr;
  }

  // ---- Build entry (per ROUTING.md routing-decision persistence) ----
  const timestamp = now();
  const entry = {
    timestamp,
    workflow,
    rationale_excerpt: truncateRationale(rationale.trim()),
    // Omit the field for non-orchestrator workflows (contract says null OR
    // omitted is acceptable; omitting keeps the log lean).
    ...(justification !== null ? { multi_domain_justification: justification } : {}),
    ...(riskTier !== null ? { risk_tier: riskTier } : {}),
  };

  // ---- Append to log via atomic read-modify-write ------------------------
  // atomicModifyJSON encapsulates lock acquisition + temp-write + rename.
  // Under concurrent invocation (test harness fires 3 parallel writes; a
  // retry chain reroutes in tight succession), the shared acquireLock
  // primitive retries only once after 100ms (REQ-034). Wrap the call in a
  // short retry loop so serialization is observable to concurrent writers
  // without bleeding into the shared lock primitive's contract.
  let writeOk = false;
  let lastLockErr = null;
  for (let attempt = 0; attempt < ROUTE_DECISION_WRITE_MAX_RETRIES; attempt++) {
    try {
      writeOk = atomicModifyJSON(
        routeDecisionSessionPath,
        (current) => {
          // First write creates the session shell if absent — mirrors the
          // defensive shape in opStartWork. But record-route-decision should
          // only run AFTER start-work has initialized the session, so we only
          // backfill missing sub-structures (active_work may be null if route
          // is called before start-work; the CLI still records for future
          // reconciliation).
          const session =
            current && typeof current === 'object' ? { ...current } : createEmptySession();

          if (!session.active_work || typeof session.active_work !== 'object') {
            session.active_work = {};
          }
          if (!Array.isArray(session.active_work.route_decisions)) {
            session.active_work.route_decisions = [];
          }
          session.active_work.route_decisions.push(entry);
          if (riskTier !== null) {
            session.active_work.risk_tier = riskTier;
          }

          // Breadcrumb in session history for operator visibility (distinct from
          // the append-only decision log itself).
          if (!Array.isArray(session.history)) {
            session.history = [];
          }
          session.history.push({
            timestamp,
            event_type: 'route_decision_recorded',
            details: {
              workflow,
              ...(riskTier !== null ? { risk_tier: riskTier } : {}),
              has_justification: justification !== null,
              justification_count: justification ? justification.length : 0,
            },
          });

          session.updated_at = timestamp;
          return session;
        },
        { failOpen: true }
      );
    } catch (err) {
      // acquireLock fail-closed path — treat as lock contention and retry.
      lastLockErr = err;
      writeOk = false;
    }
    if (writeOk) break;
    // Exponential-ish backoff with a small jitter so 3 concurrent writers
    // do not re-collide on the next attempt at the same millisecond.
    const backoff = ROUTE_DECISION_WRITE_RETRY_BASE_MS * (attempt + 1);
    const jitter = Math.floor(Math.random() * ROUTE_DECISION_WRITE_RETRY_BASE_MS);
    syncSleepMs(backoff + jitter);
  }

  if (!writeOk) {
    throw new RouteDecisionError(
      'ROUTE_DECISION_WRITE_FAILED',
      `ROUTE_DECISION_WRITE_FAILED: could not persist route decision to ${routeDecisionSessionPath} ` +
        `after ${ROUTE_DECISION_WRITE_MAX_RETRIES} attempts (lock acquisition or atomic rename failed). ` +
        `Decision NOT recorded.` +
        (lastLockErr ? ` Last lock error: ${lastLockErr.message}` : '')
    );
  }

  // ---- Audit entry (best-effort) -----------------------------------------
  // Emission is advisory: routing is not a quality-gate, so an audit chain
  // failure here should NOT mask the successful session.json write. We log
  // to stderr and move on. The chain is still consistent because
  // appendAuditEntry is atomic on its end.
  let auditSeq = null;
  try {
    const res = appendAuditEntry(
      'session_checkpoint',
      'record-route-decision',
      {
        workflow,
        risk_tier: riskTier,
        rationale_length: entry.rationale_excerpt.length,
        has_justification: justification !== null,
        justification_count: justification ? justification.length : 0,
      },
      { timestamp }
    );
    auditSeq = res && typeof res.seq === 'number' ? res.seq : null;
  } catch (err) {
    process.stderr.write(
      `[record-route-decision] WARNING: audit append failed (non-fatal): ${err && err.message}\n`
    );
  }

  // ---- Stdout / stderr output --------------------------------------------
  const out = {
    ok: true,
    workflow,
    risk_tier: riskTier,
    timestamp,
    rationale_excerpt: entry.rationale_excerpt,
    multi_domain_justification: justification,
    audit_seq: auditSeq,
  };
  console.log(JSON.stringify(out));
  console.error(
    `route-decision recorded: workflow=${workflow} ts=${timestamp}` +
      (riskTier ? ` risk_tier=${riskTier}` : '') +
      (justification ? ` criteria=${justification.length}` : '')
  );
}

/**
 * complete-work - Finalize completed work.
 */
function opCompleteWork() {
  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    console.error('No active work to complete.');
    return;
  }

  const specGroupId = session.active_work.spec_group_id;
  const objective = session.active_work.objective;
  const workflow = getWorkflowType(session);

  // Ensure we're in a completion state
  if (session.active_work.current_phase !== 'complete') {
    console.error(
      `Warning: Completing work while phase is '${session.active_work.current_phase}'. ` +
      `Consider transitioning to 'complete' first.`
    );
  }

  // --- Completion checklist (REQ-018, REQ-019, REQ-020) ---
  // Must read enforcement fields from phase_checkpoint BEFORE clearing it (INC-008)
  const enforcementLevel = getEnforcementLevel(session);
  const overrideCount = session.phase_checkpoint?.override_count || 0;
  const enforcementCounter = session.phase_checkpoint?.enforcement_counter || 0;
  const isInformationalOnly = enforcementLevel === 'off';

  if (!EXEMPT_WORKFLOWS.includes(workflow)) {
    const checklistItems = [];
    const allTasks = [
      ...(session.subagent_tasks?.in_flight || []),
      ...(session.subagent_tasks?.completed_this_session || [])
    ];

    // Build override history from session events
    const overrideHistory = (session.history || []).filter(
      h => h.event_type === 'override_skip'
    );
    const overriddenPhases = new Set(overrideHistory.map(h => h.details?.phase));

    // Check per-stage challenger dispatches (REQ-011)
    const requiredStages = REQUIRED_CHALLENGER_STAGES[workflow] || REQUIRED_CHALLENGER_STAGES['orchestrator'];
    for (const stage of requiredStages) {
      const dispatched = allTasks.some(
        t => t.subagent_type === 'challenger' && t.stage === stage
      );

      const phaseKey = `challenging:${stage}`;
      if (dispatched) {
        checklistItems.push({ label: `challenger (${stage})`, status: 'completed' });
      } else if (overriddenPhases.has(phaseKey) || overriddenPhases.has('challenging')) {
        const override = overrideHistory.find(
          h => h.details?.phase === phaseKey || h.details?.phase === 'challenging'
        );
        checklistItems.push({
          label: `challenger (${stage})`,
          status: 'overridden',
          rationale: override?.details?.rationale || 'No rationale recorded'
        });
      } else {
        checklistItems.push({ label: `challenger (${stage})`, status: 'missing' });
      }
    }

    // Check other mandatory dispatches
    const mandatoryTypes = [
      { type: 'code-reviewer', label: 'code-reviewer' },
      { type: 'security-reviewer', label: 'security-reviewer' },
      { type: 'completion-verifier', label: 'completion-verifier' },
      { type: 'documenter', label: 'documenter' }
    ];

    for (const { type, label } of mandatoryTypes) {
      const dispatched = allTasks.some(t => t.subagent_type === type);
      if (dispatched) {
        checklistItems.push({ label, status: 'completed' });
      } else if (overriddenPhases.has(type)) {
        const override = overrideHistory.find(h => h.details?.phase === type);
        checklistItems.push({
          label,
          status: 'overridden',
          rationale: override?.details?.rationale || 'No rationale recorded'
        });
      } else {
        checklistItems.push({ label, status: 'missing' });
      }
    }

    // Check for enforcement resets
    const enforcementResets = (session.history || []).filter(
      h => h.event_type === 'reset_enforcement'
    ).length;

    // Apply informational-only mode (REQ-020)
    if (isInformationalOnly) {
      for (const item of checklistItems) {
        if (item.status === 'missing') {
          item.status = 'informational';
        }
      }
    }

    // Output checklist (advisory -- does not block complete-work)
    const prefix = isInformationalOnly ? 'INFO' : 'COMPLETION CHECKLIST';
    console.error(`\n${prefix} (workflow: ${workflow}):`);
    for (const item of checklistItems) {
      switch (item.status) {
        case 'completed':
          console.error(`  [x] ${item.label}`);
          break;
        case 'overridden':
          console.error(`  [OVERRIDE] ${item.label} -- overridden: "${item.rationale}"`);
          break;
        case 'missing':
          console.error(`  [ ] ${item.label} -- MISSING`);
          break;
        case 'informational':
          console.error(`  [i] ${item.label} -- not dispatched (informational)`);
          break;
      }
    }
    if (enforcementResets > 0) {
      console.error(`  Enforcement resets: ${enforcementResets}`);
    }
    if (overrideCount > 0) {
      console.error(`  Overrides used: ${overrideCount}/${MAX_OVERRIDES_PER_SESSION}`);
    }
    console.error('');

    // Record checklist as completion_checklist event in session history (DEC-007, REQ-018)
    addHistoryEntry(session, 'completion_checklist', {
      workflow,
      items: checklistItems,
      enforcement_level: enforcementLevel,
      enforcement_resets: enforcementResets,
      override_count: overrideCount,
      enforcement_counter: enforcementCounter,
      spec_group_id: specGroupId,
      message: `Completion checklist generated for workflow '${workflow}'`
    });
  }
  // --- End completion checklist ---

  addHistoryEntry(session, 'work_completed', {
    spec_group_id: specGroupId,
    workflow: session.active_work.workflow,
    atomic_specs_completed: session.phase_checkpoint?.atomic_specs_completed || [],
    tasks_completed: session.subagent_tasks.completed_this_session.length,
    message: `Completed work: ${objective}`
  });

  // as-005 / REQ-005 / AC-005.6 trigger 5 (session-end): clear every live
  // test-writer-unlock entry BEFORE nulling active_work. The predicate appends
  // one `test_writer_unlock_refence` audit entry per cleared sg-id via the
  // sole-writer path, keyed with `trigger: 'session-end'` so audit consumers
  // can distinguish it from the other 4 triggers. Runs inside the same
  // session-save transaction as the work_completed breadcrumb (design-doc
  // §4.2, Q2 resolution). Idempotent no-op when active_work.test_writer_unlock
  // is absent or empty.
  try {
    evaluateRefenceTriggerForAllUnlocks(session, 'session-end');
  } catch (err) {
    // Audit-append failure (genesis broken / chain broken) must not wedge
    // complete-work: surface via stderr, leave the unlock entries intact so
    // the next session can retry once the chain is repaired, and continue
    // the wipe. session.active_work is about to be nulled anyway — the
    // unlock entries vanish with it. Next dispatch hits fenced mode by
    // default (AC-005.2) so no security regression.
    //
    // Code-review Pass 1 M4: emit a structured warning line matching the
    // TestWriterUnlockError pattern so log-scraping tools can key on the
    // stable code `REFENCE_SESSION_END_AUDIT_FAILED` rather than parsing
    // free-form English.
    console.error(
      `[session-checkpoint] WARN code=REFENCE_SESSION_END_AUDIT_FAILED spec_group=${specGroupId} error=${err && err.message}`
    );
  }

  // Clear active state
  session.active_work = null;
  session.phase_checkpoint = null;

  // Unregister this session from the active-sessions registry.
  if (session.session_id) {
    unregisterActiveSession(session, session.session_id);
  }

  // Keep completed_this_session for reference but clear in_flight
  // Any in_flight tasks are considered abandoned
  for (const task of session.subagent_tasks.in_flight) {
    task.status = 'cancelled';
    task.completed_at = now();
    task.result_summary = 'Cancelled: work completed';
    session.subagent_tasks.completed_this_session.push(task);
  }
  session.subagent_tasks.in_flight = [];

  saveSession(session, { allowSnapshotLifecycleReset: true });
  console.error(`Completed work on '${specGroupId}'`);
}

/**
 * archive-incomplete - Archive incomplete work to history.
 */
function opArchiveIncomplete() {
  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    console.error('No active work to archive.');
    return;
  }

  const specGroupId = session.active_work.spec_group_id;
  const objective = session.active_work.objective;
  const currentPhase = session.active_work.current_phase;

  addHistoryEntry(session, 'work_abandoned', {
    spec_group_id: specGroupId,
    workflow: session.active_work.workflow,
    abandoned_at_phase: currentPhase,
    atomic_specs_completed: session.phase_checkpoint?.atomic_specs_completed || [],
    atomic_specs_pending: session.phase_checkpoint?.atomic_specs_pending || [],
    in_flight_tasks: session.subagent_tasks.in_flight.map(t => t.task_id),
    message: `Abandoned work at phase '${currentPhase}': ${objective}`
  });

  // as-005 / REQ-005 / AC-005.6 trigger 5 (session-end): clear every live
  // test-writer-unlock entry BEFORE nulling active_work. EC-WS2-8: a
  // subsequent session restart must NOT re-activate a pre-archive unlock —
  // the predicate appends the audit entry so the chain records the clear
  // before active_work is wiped. Same fail-soft semantics as opCompleteWork
  // (warn + continue on audit-append failure; entries vanish with the wipe).
  try {
    evaluateRefenceTriggerForAllUnlocks(session, 'session-end');
  } catch (err) {
    // Code-review Pass 1 M4: structured warning code (see opCompleteWork
    // above for the rationale). `archive-incomplete` shares the same
    // session-end trigger; the code is identical so audit-log consumers
    // aggregate both paths under REFENCE_SESSION_END_AUDIT_FAILED.
    console.error(
      `[session-checkpoint] WARN code=REFENCE_SESSION_END_AUDIT_FAILED spec_group=${specGroupId} error=${err && err.message}`
    );
  }

  // Clear active state
  session.active_work = null;
  session.phase_checkpoint = null;

  // Cancel in_flight tasks
  for (const task of session.subagent_tasks.in_flight) {
    task.status = 'cancelled';
    task.completed_at = now();
    task.result_summary = 'Cancelled: work archived incomplete';
    session.subagent_tasks.completed_this_session.push(task);
  }
  session.subagent_tasks.in_flight = [];

  saveSession(session, { allowSnapshotLifecycleReset: true });
  console.error(`Archived incomplete work on '${specGroupId}' (was at phase '${currentPhase}')`);
}

/**
 * journal-created - Mark that a journal entry has been created.
 */
function opJournalCreated(journalPath) {
  if (!journalPath) {
    throw new Error('Usage: journal-created <path-to-journal>');
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.phase_checkpoint) {
    throw new Error('No phase checkpoint. This should not happen.');
  }

  session.phase_checkpoint.journal_created = true;
  session.phase_checkpoint.journal_entry_path = journalPath;

  addHistoryEntry(session, 'checkpoint_saved', {
    spec_group_id: session.active_work?.spec_group_id,
    message: `Journal entry created: ${journalPath}`
  });

  saveSession(session);
  console.error(`Marked journal entry as created: ${journalPath}`);
}

/**
 * override-skip - Clear skip counter for a specific phase with audit trail (REQ-008).
 * Main-agent-only, subject to per-session override cap (shared with reset-enforcement).
 */
function opOverrideSkip(phase, rationale) {
  if (!phase || !rationale) {
    throw new Error('Usage: override-skip --phase <phase> --rationale "<reason>"');
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    throw new Error('No active work. Run "start-work" first.');
  }

  // Access control: main-agent-only (REQ-008)
  if (!isMainAgent(session)) {
    throw new Error('Only the main agent (no subagents in-flight) may override-skip.');
  }

  // Ensure enforcement fields exist (backward compatibility)
  if (!session.phase_checkpoint) {
    throw new Error('No phase checkpoint. Run "start-work" first.');
  }
  const overrideCount = session.phase_checkpoint.override_count || 0;

  // Check per-session cap (shared with reset-enforcement, max 3) (REQ-008)
  if (overrideCount >= MAX_OVERRIDES_PER_SESSION) {
    console.error(`Error: Override cap reached (${MAX_OVERRIDES_PER_SESSION}/${MAX_OVERRIDES_PER_SESSION}). Escalate to human with full context.`);
    process.exit(1);
  }

  // Clear skip counter for the specified phase
  if (!session.phase_checkpoint.phase_skip_warnings) {
    session.phase_checkpoint.phase_skip_warnings = {};
  }
  delete session.phase_checkpoint.phase_skip_warnings[phase];

  // Increment counters
  session.phase_checkpoint.enforcement_counter = (session.phase_checkpoint.enforcement_counter || 0) + 1;
  session.phase_checkpoint._counter_checksum = computeCounterChecksum(session.phase_checkpoint.enforcement_counter);
  session.phase_checkpoint.override_count = overrideCount + 1;

  // Log to session history (DEC-007)
  addHistoryEntry(session, 'override_skip', {
    phase,
    rationale,
    override_number: overrideCount + 1,
    cap: MAX_OVERRIDES_PER_SESSION,
    spec_group_id: session.active_work.spec_group_id,
    message: `Override-skip for phase '${phase}': ${rationale}`
  });

  saveSession(session);
  console.error(`Override-skip applied for phase '${phase}' (${overrideCount + 1}/${MAX_OVERRIDES_PER_SESSION} overrides used).`);
}

/**
 * reset-enforcement - Clear ALL skip counters with audit trail (REQ-009).
 * Main-agent-only, subject to per-session override cap (shared with override-skip).
 */
function opResetEnforcement(rationale) {
  if (!rationale) {
    throw new Error('Usage: reset-enforcement --rationale "<reason>"');
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    throw new Error('No active work. Run "start-work" first.');
  }

  // Access control: main-agent-only (REQ-009)
  if (!isMainAgent(session)) {
    throw new Error('Only the main agent (no subagents in-flight) may reset-enforcement.');
  }

  if (!session.phase_checkpoint) {
    throw new Error('No phase checkpoint. Run "start-work" first.');
  }
  const overrideCount = session.phase_checkpoint.override_count || 0;

  // Check per-session cap (shared with override-skip, max 3) (REQ-009)
  if (overrideCount >= MAX_OVERRIDES_PER_SESSION) {
    console.error(`Error: Override cap reached (${MAX_OVERRIDES_PER_SESSION}/${MAX_OVERRIDES_PER_SESSION}). Escalate to human with full context.`);
    process.exit(1);
  }

  // Clear ALL skip counters
  session.phase_checkpoint.phase_skip_warnings = {};

  // Increment counters
  session.phase_checkpoint.enforcement_counter = (session.phase_checkpoint.enforcement_counter || 0) + 1;
  session.phase_checkpoint._counter_checksum = computeCounterChecksum(session.phase_checkpoint.enforcement_counter);
  session.phase_checkpoint.override_count = overrideCount + 1;

  // Log to session history (DEC-007)
  addHistoryEntry(session, 'reset_enforcement', {
    rationale,
    override_number: overrideCount + 1,
    cap: MAX_OVERRIDES_PER_SESSION,
    spec_group_id: session.active_work.spec_group_id,
    message: `Reset enforcement: ${rationale}`
  });

  saveSession(session);
  console.error(`Enforcement reset applied (${overrideCount + 1}/${MAX_OVERRIDES_PER_SESSION} overrides used). All skip counters cleared.`);
}

/**
 * set-enforcement-level - Change enforcement level with audit trail (REQ-010).
 * Main-agent-only. Does NOT count toward override cap. Does NOT reset skip counters.
 */
function opSetEnforcementLevel(level) {
  if (!level) {
    throw new Error('Usage: set-enforcement-level <off|warn-only|graduated>');
  }

  if (!VALID_ENFORCEMENT_LEVELS.includes(level)) {
    throw new Error(`Invalid enforcement level '${level}'. Valid levels: ${VALID_ENFORCEMENT_LEVELS.join(', ')}`);
  }

  const session = loadSession();
  if (!session) {
    throw new Error('No session.json exists. Run "init" first.');
  }

  if (!session.active_work) {
    throw new Error('No active work. Run "start-work" first.');
  }

  // Access control: main-agent-only (REQ-010)
  if (!isMainAgent(session)) {
    throw new Error('Only the main agent (no subagents in-flight) may change enforcement level.');
  }

  if (!session.phase_checkpoint) {
    throw new Error('No phase checkpoint. Run "start-work" first.');
  }

  const oldLevel = session.phase_checkpoint.enforcement_level || 'graduated';

  if (oldLevel === level) {
    console.error(`Enforcement level is already '${level}'.`);
    return;
  }

  // Change level -- does NOT reset skip counters (EC-11)
  session.phase_checkpoint.enforcement_level = level;

  // Log to session history (DEC-007) -- does NOT count toward override cap
  addHistoryEntry(session, 'enforcement_level_change', {
    from_level: oldLevel,
    to_level: level,
    spec_group_id: session.active_work.spec_group_id,
    message: `Enforcement level changed from '${oldLevel}' to '${level}'`
  });

  saveSession(session);
  console.error(`Enforcement level changed from '${oldLevel}' to '${level}'.`);
}

/**
 * get-status - Output current session state summary as JSON.
 */
function opGetStatus() {
  const session = loadSession();

  if (!session) {
    const status = {
      exists: false,
      has_active_work: false,
      message: 'No session.json found. Run "init" to create one.'
    };
    console.error(JSON.stringify(status, null, 2));
    return;
  }

  const status = {
    exists: true,
    version: session.version,
    updated_at: session.updated_at,
    has_active_work: session.active_work !== null,
    active_work: session.active_work ? {
      spec_group_id: session.active_work.spec_group_id,
      workflow: session.active_work.workflow,
      current_phase: session.active_work.current_phase,
      objective: session.active_work.objective
    } : null,
    phase_checkpoint: session.phase_checkpoint ? {
      phase: session.phase_checkpoint.phase,
      atomic_specs_completed_count: session.phase_checkpoint.atomic_specs_completed?.length || 0,
      atomic_specs_pending_count: session.phase_checkpoint.atomic_specs_pending?.length || 0,
      next_actions: session.phase_checkpoint.next_actions || []
    } : null,
    subagent_tasks: {
      in_flight_count: session.subagent_tasks.in_flight.length,
      completed_this_session_count: session.subagent_tasks.completed_this_session.length,
      in_flight: session.subagent_tasks.in_flight.map(t => ({
        task_id: t.task_id,
        subagent_type: t.subagent_type,
        status: t.status
      }))
    },
    history_count: session.history.length,
    recent_history: session.history.slice(-5).map(h => ({
      timestamp: h.timestamp,
      event_type: h.event_type,
      message: h.details?.message
    }))
  };

  console.error(JSON.stringify(status, null, 2));
}

/**
 * record-pass - Append a pass evidence record to convergence_evidence in session.json.
 *
 * Usage: record-pass <gate_name> --findings-count <N> --findings-hash <hash>
 *        --clean <true|false> --agent-type <type>
 *        [--auto-decision-batch-id <id>] [--auto-decision-complete <true|false>]
 *
 * NOTE: the `--source` flag is no longer supported via CLI. Every
 * `--source` value -- `hook`,
 * `manual`, `hook_manual`, `parse_failed`, `manual_fallback` -- exits non-zero
 * with `SOURCE_FORBIDDEN_VIA_CLI`. All pass evidence writes are programmatic
 * via `recordPass()` module import (sole importer: convergence-pass-recorder.mjs).
 * Rationale: sg-e2e-runtime-connectivity incident (18 passes, 4 consecutive
 * clean, derivation returned 0 because manual mirrors broke the hook streak).
 *
 * Implements: REQ-001 (AC-1.1), REQ-009 (AC-1.2), REQ-018 (AC-1.3),
 *   REQ-010 (AC-1.4), REQ-007 (AC-1.5), REQ-020 (AC-1.7)
 * Current contract: CLI source rejection plus programmatic recorder source enum.
 */
function opRecordPass(args) {
  // Parse gate name (first positional arg)
  const gateName = args[0];
  if (!gateName) {
    throw new Error('Usage: record-pass <gate_name> --findings-count <N> --clean <true|false> --agent-type <type>');
  }

  // Validate gate name
  if (!VALID_CONVERGENCE_GATES.includes(gateName)) {
    throw new Error(
      `Invalid gate_name '${gateName}'. Valid gate names: ${VALID_CONVERGENCE_GATES.join(', ')}`
    );
  }

  // Parse named arguments
  let findingsCount = null;
  let findingsHash = null;
  let clean = null;
  let agentType = null;
  let source = 'hook';
  let autoDecisionBatchId = null;
  let autoDecisionComplete = null;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--findings-count':
        i++;
        findingsCount = args[i] === 'null' ? null : Number(args[i]);
        break;
      case '--findings-hash':
        i++;
        findingsHash = args[i] === 'null' ? null : args[i];
        break;
      case '--clean':
        i++;
        clean = args[i] === 'true';
        break;
      case '--agent-type':
        i++;
        agentType = args[i];
        break;
      case '--source':
        i++;
        source = args[i];
        break;
      case '--auto-decision-batch-id':
        i++;
        autoDecisionBatchId = args[i];
        break;
      case '--auto-decision-complete':
        i++;
        autoDecisionComplete = args[i] === 'true';
        break;
    }
  }

  // CLI contract: reject ALL `--source` values at CLI entry. Previously only
  // `hook` was rejected; now `manual`, `hook_manual`, `parse_failed`, and
  // `manual_fallback` are also rejected. The four remaining values were
  // operator-injection surfaces (`manual`, `hook_manual`) or programmatic-only
  // values (`parse_failed`, `manual_fallback`) written by the hook-path
  // recorder (convergence-pass-recorder.mjs) via module import.
  //
  // All pass evidence writes are now programmatic. Rejection is unconditional
  // on env state (no CLAUDE_HOOK_EVENT bypass, no NODE_ENV bypass, no
  // $USER-dependent gating -- see AC-9). MUST occur before any state mutation.
  //
  // Incident rationale: sg-e2e-runtime-connectivity observed 18 total pass
  // evidence records, 4 consecutive clean passes written by the hook, but
  // `update-convergence` derivation returned `clean_pass_count = 0` because
  // manual mirrors interleaved with hook records broke the consecutive-clean
  // streak. Removing the operator-injection surface prevents this class of
  // false-negative.
  const REJECTED_CLI_SOURCES = ['hook', 'manual', 'hook_manual', 'parse_failed', 'manual_fallback'];
  if (REJECTED_CLI_SOURCES.includes(source)) {
    process.stderr.write(
      `SOURCE_FORBIDDEN_VIA_CLI: pass recording via --source ${source} is not supported. ` +
      `All pass evidence writes are programmatic, performed by convergence-pass-recorder.mjs ` +
      `via module import only. See the ` +
      `sg-e2e-runtime-connectivity incident (18 passes, 4 consecutive clean, derivation ` +
      `returned 0 because manual mirrors broke the hook streak).\n`
    );
    process.exit(2);
  }

  // Validate required fields
  if (clean === null) {
    throw new Error('Missing required argument: --clean <true|false>');
  }
  if (!agentType) {
    // With CLI rejecting every --source value above, no remediation path remains where agent-type
    // can be auto-supplied. Retained as the sole required-arg contract.
    throw new Error('Missing required argument: --agent-type <type>');
  }

  // Defense-in-depth enum validator: CLI validSources is intentionally empty
  // because every known --source value was
  // rejected by the REJECTED_CLI_SOURCES block above. This validator catches
  // any unknown --source values that bypass the block (e.g., typos, future
  // enum additions before the block is updated). Effective behavior: any
  // non-default --source value exits non-zero.
  const validSources = [];
  if (source !== undefined && source !== null && !validSources.includes(source)) {
    throw new Error(`INVALID_SOURCE: '${source}'. The --source flag is no longer supported via CLI; all sources are programmatic.`);
  }

  // Validate findings-hash format (64-char hex or null)
  if (findingsHash !== null && !/^[a-f0-9]{64}$/.test(findingsHash)) {
    throw new Error(`Invalid findings-hash '${findingsHash}'. Must be a 64-character hex string or null.`);
  }

  // Validate findings-count is non-negative integer or null
  if (findingsCount !== null && (!Number.isInteger(findingsCount) || findingsCount < 0)) {
    throw new Error(`Invalid findings-count '${findingsCount}'. Must be a non-negative integer or null.`);
  }

  // Atomic read-modify-write to prevent lost updates (lock held for entire cycle)
  ensureContextDir();
  let reportPassNumber = null;
  let reportClean = null;

  const written = atomicModifyJSON(SESSION_PATH, (currentData) => {
    let session = currentData;
    if (!session) {
      // AC-1.9: Corrupt or missing -- create fresh session
      session = createEmptySession();
    }

    // AC-1.5: Initialize convergence_evidence schema if missing
    if (!session.convergence_evidence) {
      session.convergence_evidence = {};
    }
    if (!session.convergence_evidence[gateName]) {
      session.convergence_evidence[gateName] = { passes: [] };
    }

    const passes = session.convergence_evidence[gateName].passes;

    // AC-1.3: Duplicate detection -- compute next pass_number
    const nextPassNumber = passes.length > 0
      ? passes[passes.length - 1].pass_number + 1
      : 1;

    // Check for duplicate pass_number
    if (passes.some(p => p.pass_number === nextPassNumber)) {
      console.error(`WARNING: Duplicate pass_number ${nextPassNumber} for gate '${gateName}' -- record rejected.`);
      process.exit(1);
    }

    // AC-1.7: Incomplete auto-decision batch marks pass as dirty
    let effectiveClean = clean;
    let effectiveAutoDecisionComplete = autoDecisionComplete;
    if (autoDecisionBatchId && autoDecisionComplete === false) {
      effectiveClean = false;
      effectiveAutoDecisionComplete = false;
    }

    // Build pass evidence record (AC-1.1)
    const record = {
      pass_number: nextPassNumber,
      timestamp: now(),
      agent_type: agentType,
      findings_count: findingsCount,
      findings_hash: findingsHash,
      clean: effectiveClean,
      record_source: source,
    };

    // as-013 / AC13.2: persist content_hash on content-hash-attested gates.
    // Only compute for gates with attestation_mode='content-hash' in
    // PerGateThresholdTable; other gates skip the fs-touching helper
    // entirely. On helper failure we omit the field so EC-7 fallback
    // triggers at derive time (unchanged convergence semantics).
    if (gateUsesContentHashAttestation(gateName)) {
      const contentHash = computeGateContentHashOrNull(gateName, session);
      if (typeof contentHash === 'string' && contentHash.length > 0) {
        record.content_hash = contentHash;
      }
    }

    // AC-1.2: Include auto-decision fields if provided
    if (autoDecisionBatchId !== null) {
      record.auto_decision_batch_id = autoDecisionBatchId;
      record.auto_decision_complete = effectiveAutoDecisionComplete !== null
        ? effectiveAutoDecisionComplete
        : true; // defaults to true if batch ID is present
    }

    // AC-1.4: Append-only -- push new record without modifying existing ones
    passes.push(record);

    // Iteration tracking: increment iteration_count for this gate
    if (!session.convergence) {
      session.convergence = {};
    }
    if (!session.convergence[gateName]) {
      session.convergence[gateName] = { clean_pass_count: 0 };
    }
    const currentIterations = session.convergence[gateName].iteration_count || 0;
    session.convergence[gateName].iteration_count = currentIterations + 1;

    // Add history entry
    addHistoryEntry(session, 'convergence_pass_recorded', {
      gate_name: gateName,
      pass_number: nextPassNumber,
      clean: effectiveClean,
      record_source: source,
      agent_type: agentType,
      message: `Recorded pass ${nextPassNumber} for ${gateName}: clean=${effectiveClean}, source=${source}`,
    });

    // Mirror the invariant set by the programmatic recordPass() module export so
    // any legacy --source path that still reaches this branch maintains atomicity
    // of history.push + last_pass_history_index. Same atomicModifyJSON transaction.
    session.convergence[gateName].last_pass_history_index = session.history.length - 1;

    session.updated_at = now();
    reportPassNumber = nextPassNumber;
    reportClean = effectiveClean;
    return session;
  }, { failOpen: false });
  console.error(`Recorded pass ${reportPassNumber} for ${gateName}: clean=${reportClean}, source=${source}`);
}

// ws-counter-derivation / sg-workflow-convergence-bugs (Bug A):
// Canonical source enum -- records with these sources participate in both
// iteration_count and clean_pass_count derivation.
const CANONICAL_SOURCES = new Set(['hook', 'parse_failed', 'manual_fallback']);

// ws-counter-derivation / SEC-101 (supersedes pass-1 TECH-001/SEC-001):
// Legacy source enum -- records with these sources are INVISIBLE to the
// tail-walk. They do not advance the streak walker as a gap, do not count
// toward iteration_count, and do not reset clean_pass_count. This closes
// the asymmetric DoS vector where adversary-crafted legacy records could
// inflate iteration_count to the CONVERGENCE FAILURE cap without any
// legitimate convergence activity.
const LEGACY_SOURCES = new Set(['manual', 'hook_manual']);

// Tail-walk bound preserved from prior behavior (NFR-2).
const TAIL_WALK_BOUND = 200;

/**
 * Hash a session identifier for structured log emission. Uses SHA-256 digest
 * first 16 hex chars. Avoids leaking raw paths/identifiers in audit logs.
 *
 * @param {string} sessionId - Raw session identifier (may be path or id)
 * @returns {string} 16-char hex digest or "<unknown>"
 */
function hashSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return '<unknown>';
  try {
    return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  } catch {
    return '<unknown>';
  }
}

/**
 * Emit a structured log line to stderr in JSON format.
 * Contract: `contract-structured-log-keys` (MasterSpec sg-workflow-convergence-bugs).
 * Keys emitted by derivation path (owned by ws-counter-derivation):
 *   - convergence.streak.derived {gate, clean_pass_count, iteration_count}
 *   - convergence.legacy_source_rejected {gate, source, recordIndex, sessionId}
 *   - convergence.session_parse_failed {path, error_detail}
 *
 * @param {string} event - Closed-enum event name
 * @param {object} fields - Structured field payload
 */
function emitDerivationLog(event, fields) {
  try {
    process.stderr.write(
      JSON.stringify({ event, ...fields }) + '\n'
    );
  } catch {
    // Never throw from logging path; silent failure preferable to cascading errors.
  }
}

// =============================================================================
// as-013 / REQ-001 / AC13.2 -- content-hash computation for record-pass path.
// =============================================================================

/**
 * Compute the hash-input-manifest content-hash for a gate at recordPass()
 * time, returning `null` on any failure. Invoked only for gates configured
 * with `attestation_mode: "content-hash"` in the PerGateThresholdTable.
 *
 * Failure modes (each returns `null`, trapped + logged to stderr; never
 * throws):
 *   - Gate has no table entry or no `hash_input_manifest` array.
 *   - `HashInputError` from the helper: HASH_INPUT_MISSING (spec file gone),
 *     HASH_INPUT_UNRESOLVED (spec_group_id unset), HASH_INPUT_GIT_FAILED
 *     (git binary missing / bad range), HASH_INPUT_INVALID_ENTRY
 *     (unsupported glob shape).
 *   - Generic error (ENOENT on cwd, permissions).
 *
 * Returning `null` is the EC-7 safe path: without a persisted content_hash
 * on a pass record, `shouldSkipForAttestation()` returns `no-skip` and the
 * gate reverts to `required_clean_passes` consecutive clean passes. No
 * convergence write is blocked by this branch.
 *
 * Empty manifest arrays (e.g., investigation / challenger with
 * `attestation_mode: "none"`) are NOT reached here because the caller
 * guards on `gateUsesContentHashAttestation()` first. A content-hash gate
 * with an empty manifest would still produce a deterministic SHA-256 of
 * the empty stream, which is valid.
 *
 * @param {string} gateName - Consumer-short gate name (e.g. 'unifier').
 * @param {object} session - Session object; reads `active_work.spec_group_id`
 *                           for placeholder substitution.
 * @returns {string | null} Lowercase 64-char hex digest, or null on any
 *                          failure.
 */
function computeGateContentHashOrNull(gateName, session) {
  const entry = resolveTableEntryForGate(gateName);
  if (!entry || !Array.isArray(entry.hash_input_manifest)) {
    return null;
  }
  const specGroupId = session?.active_work?.spec_group_id;
  try {
    const { content_hash } = computeHashInputManifest(entry, {
      spec_group_id: specGroupId,
      // cwd defaults to process.cwd() inside the helper; matching here is
      // intentional -- recordPass runs in the project root for every
      // invocation path (CLI + hook import).
    });
    return content_hash;
  } catch (err) {
    // Trap + log. Downstream EC-7 fallback triggers automatically because
    // no content_hash ends up on the pass record.
    emitDerivationLog('convergence.content_hash_compute_failed', {
      gate: gateName,
      spec_group_id: specGroupId ?? '<unset>',
      error_code:
        err && typeof err === 'object' && typeof err.code === 'string'
          ? err.code
          : 'UNKNOWN',
      error_message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Derive convergence state from pass evidence (READ-ONLY on disk and on input).
 *
 * Spec: sg-workflow-convergence-bugs (ws-counter-derivation).
 * Implements: R-001 (iteration_count), R-002 (clean_pass_count streak),
 *             R-003 (unconditional reset on dirty, idempotent),
 *             R-004 (legacy-invisible via SEC-101),
 *             R-005 (read-only on passes[] -- no mutation, no write),
 *             R-019 (structured logs).
 *
 * Tail-walk semantics (bounded to last 200 entries):
 *   - Record source in LEGACY_SOURCES -> INVISIBLE: skip entirely; emit
 *     convergence.legacy_source_rejected; counters unchanged; streak liveness
 *     preserved (the legacy record is not a gap).
 *   - Record source not in CANONICAL_SOURCES and not in LEGACY_SOURCES -> unknown,
 *     treated as legacy (skip + log with observed source string).
 *   - Record missing source or clean field -> treated as legacy (skip + log).
 *   - Record source in CANONICAL_SOURCES -> eligible; increments iteration_count.
 *     - If clean === true AND streak still live -> clean_pass_count += 1.
 *     - If clean === false -> streak frozen for remainder of walk. Idempotent:
 *       consecutive dirties each reset but cumulative effect = one reset.
 *
 * Contract: this function is PURE and READ-ONLY. It does not mutate
 * `passes[]` nor any parent object. It emits structured logs as a
 * side-effect on stderr. No fs writes.
 *
 * @param {Array<object>} passes - session.convergence_evidence[gate].passes or []
 * @param {string} gateName - Gate label for log emission
 * @param {string} [sessionId] - Raw session identifier; hashed before logging
 * @returns {{clean_pass_count: number, iteration_count: number}}
 */
function deriveConvergenceFromEvidence(passes, gateName, sessionId) {
  const gate = gateName || 'unknown';
  const sessionIdHash = hashSessionId(sessionId);

  if (!Array.isArray(passes) || passes.length === 0) {
    emitDerivationLog('convergence.streak.derived', {
      gate,
      clean_pass_count: 0,
      iteration_count: 0,
    });
    return { clean_pass_count: 0, iteration_count: 0 };
  }

  // Bound the walk to the last TAIL_WALK_BOUND entries. windowStart is the
  // original index in `passes` of window[0]; used so that
  // convergence.legacy_source_rejected.recordIndex reflects the true position
  // in the source array, not the window-local offset.
  const windowStart = Math.max(0, passes.length - TAIL_WALK_BOUND);
  const window = passes.slice(windowStart);

  let iterationCount = 0;
  let cleanPassCount = 0;
  let streakLive = true;

  // Walk from the tail (latest record) backwards through the window.
  // Each iteration processes exactly one record; no index advances beyond +1.
  for (let i = window.length - 1; i >= 0; i--) {
    const record = window[i];
    const originalIndex = windowStart + i;

    // Malformed-record guard: missing or non-object record. Treat as legacy
    // (skip both counters, emit rejection log). Does not crash the reducer.
    if (!record || typeof record !== 'object') {
      emitDerivationLog('convergence.legacy_source_rejected', {
        gate,
        source: '<undefined>',
        recordIndex: originalIndex,
        sessionId: sessionIdHash,
      });
      continue;
    }

    const rawSource = record.record_source;
    const observedSource = typeof rawSource === 'string' ? rawSource : '<undefined>';

    // R-004 / SEC-101: legacy sources are invisible to the walk. Log and skip.
    if (LEGACY_SOURCES.has(rawSource)) {
      emitDerivationLog('convergence.legacy_source_rejected', {
        gate,
        source: rawSource,
        recordIndex: originalIndex,
        sessionId: sessionIdHash,
      });
      continue;
    }

    // EC-A3 / EC-A4: unknown sources or missing clean field -> treated as legacy.
    if (!CANONICAL_SOURCES.has(rawSource) || typeof record.clean !== 'boolean') {
      emitDerivationLog('convergence.legacy_source_rejected', {
        gate,
        source: observedSource,
        recordIndex: originalIndex,
        sessionId: sessionIdHash,
      });
      continue;
    }

    // Canonical eligible record: contributes to iteration_count.
    iterationCount += 1;

    // Streak logic: increment clean_pass_count iff clean=true AND streak still live.
    // `clean: false` freezes the streak for the remainder of the walk. Consecutive
    // dirties idempotently freeze (no cumulative effect on cleanPassCount beyond
    // the first freeze).
    if (streakLive) {
      if (record.clean === true) {
        cleanPassCount += 1;
      } else {
        streakLive = false;
      }
    }
  }

  // R-019: emit one streak.derived log per derivation call (post-walk).
  emitDerivationLog('convergence.streak.derived', {
    gate,
    clean_pass_count: cleanPassCount,
    iteration_count: iterationCount,
  });

  return { clean_pass_count: cleanPassCount, iteration_count: iterationCount };
}

/**
 * Backward-compatible shim over deriveConvergenceFromEvidence that returns
 * only the clean_pass_count scalar. Preserves the countConsecutiveCleanFromTail
 * prior call sites without requiring signature updates across consumers.
 *
 * Behavior delta vs pre-fix implementation:
 *   - Legacy sources (manual, hook_manual) are now invisible (SEC-101), not
 *     streak-breaking. Pre-fix semantics broke the streak on legacy encounter.
 *   - parse_failed and manual_fallback with clean=true now admit to the streak
 *     (canonical source enum). Pre-fix semantics only counted hook+clean.
 *   - 200-entry bound preserved.
 *   - CONVERGENCE_TAIL_WALK_BOUNDED stderr warning preserved when the entire
 *     window is non-eligible (no canonical eligible record present).
 *
 * @param {Array<object>} passes - Array of pass evidence records
 * @param {string} [gateName] - Optional gate name for stderr warnings
 * @returns {number} clean_pass_count -- tail-anchored consecutive clean+eligible
 */
function countConsecutiveCleanFromTail(passes, gateName) {
  const { clean_pass_count } = deriveConvergenceFromEvidence(passes, gateName, null);

  // Preserve legacy-pollution defense warning: if 200+ entries exist AND no
  // canonical eligible record appears anywhere in the window, emit the
  // CONVERGENCE_TAIL_WALK_BOUNDED stderr warning. Existing downstream tests
  // consume this token; keep it to avoid cross-spec regression.
  if (Array.isArray(passes) && passes.length >= TAIL_WALK_BOUND) {
    const window = passes.slice(passes.length - TAIL_WALK_BOUND);
    const hasEligible = window.some(
      (p) =>
        p &&
        typeof p === 'object' &&
        CANONICAL_SOURCES.has(p.record_source) &&
        typeof p.clean === 'boolean',
    );
    if (!hasEligible) {
      const gateLabel = gateName || 'unknown';
      process.stderr.write(
        `CONVERGENCE_TAIL_WALK_BOUNDED: gate=${gateLabel} walked ${TAIL_WALK_BOUND} ` +
        `entries without streak start, possible legacy pollution from before 2026-04-16\n`
      );
    }
  }
  return clean_pass_count;
}

/**
 * update-convergence - Derive clean_pass_count from evidence array.
 *
 * Usage: update-convergence <gate_name>
 * Valid gate_name: code_review, security_review, investigation, challenger, unifier, completion_verifier
 *
 * AC-2.1: Derives count from evidence (no count argument)
 * AC-2.2: Rejects old API with numeric second argument
 * AC-2.3: Counts consecutive clean from tail
 * AC-2.4: Manual passes not counted
 * AC-2.5: Empty evidence yields 0
 * AC-2.8: >50% manual passes emits warning
 *
 * Implements: REQ-002, REQ-004, REQ-017, REQ-019, REQ-022
 */
function opUpdateConvergence(gateName, countStr) {
  // Required clean passes threshold (matches CLAUDE.md convergence loop protocol).
  // Named per EC-13 fallback convention (spec.md:418) so the grep-lock at
  // ci/grep-lock-thresholds.mjs:177-184 allowlists this declaration via
  // `allowIfContainedIn: ['DEFAULT_REQUIRED_CLEAN_PASSES']`. AC27.3 bans bare
  // `REQUIRED_CLEAN_PASSES = 2` in consumer files; the DEFAULT_-prefix signals
  // this is the spec-sanctioned fallback used when the snapshot is absent.
  const DEFAULT_REQUIRED_CLEAN_PASSES = 2;

  // AC-2.2: Reject old API with numeric second argument
  if (countStr !== undefined && countStr !== null && countStr !== '') {
    throw new Error(
      `The update-convergence command no longer accepts a count argument.\n` +
      `The clean_pass_count is now derived from the evidence array.\n\n` +
      `Old API (rejected): update-convergence ${gateName} ${countStr}\n` +
      `New API:            update-convergence ${gateName}\n\n` +
      `To record a pass, use: record-pass ${gateName} --findings-count <N> --clean <true|false> --agent-type <type>\n` +
      `Then call: update-convergence ${gateName}`
    );
  }

  if (!gateName) {
    throw new Error('Usage: update-convergence <gate_name>');
  }

  // Validate gate_name against enum
  if (!VALID_CONVERGENCE_GATES.includes(gateName)) {
    throw new Error(
      `Invalid gate_name '${gateName}'. Valid gate names: ${VALID_CONVERGENCE_GATES.join(', ')}`
    );
  }

  // Atomic read-modify-write to prevent lost updates (lock held for entire cycle)
  ensureContextDir();
  let reportCleanPassCount = null;
  let reportEvidenceCount = null;

  // as-006 (sg-workflow-convergence-bugs): session.json parse-failure recovery
  // (EDGE-103 / AC-A-SESSION-PARSE-FAIL). When session.json is absent or cannot
  // be JSON.parse'd, emit convergence.session_parse_failed and fail-closed
  // without invoking the reducer tail-walk. error_detail is truncated to 200
  // chars; no stack trace leaks to the audit log.
  const sessionReadCheck = (() => {
    if (!existsSync(SESSION_PATH)) {
      return { ok: false, error_detail: 'ENOENT: session.json does not exist' };
    }
    try {
      const raw = readFileSync(SESSION_PATH, 'utf8');
      JSON.parse(raw);
      return { ok: true };
    } catch (err) {
      const msg = err && typeof err.message === 'string' ? err.message : String(err);
      return { ok: false, error_detail: msg.slice(0, 200) };
    }
  })();

  if (!sessionReadCheck.ok) {
    emitDerivationLog('convergence.session_parse_failed', {
      path: SESSION_PATH,
      error_detail: sessionReadCheck.error_detail,
    });
    // Fail-closed: throw the structured CONVERGENCE_SESSION_PARSE_FAILED error
    // so the CLI exits non-zero and downstream callers see the fail-closed
    // signal. The structured log line on stderr carries root-cause detail for
    // operator triage; the thrown error message carries the same detail for
    // callers using execFileSync.
    throw new Error(
      `CONVERGENCE_SESSION_PARSE_FAILED: gate=${gateName}, ` +
      `error_detail=${sessionReadCheck.error_detail}`
    );
  }

  const written = atomicModifyJSON(SESSION_PATH, (currentData) => {
    const session = currentData;
    if (!session) {
      // Defense-in-depth: sessionReadCheck validated parse above; this branch
      // handles the race where session.json is concurrently deleted between
      // pre-check and atomicModifyJSON read. Emit the structured log and
      // convert to the fail-closed error (symmetric with AC-6.2 path).
      emitDerivationLog('convergence.session_parse_failed', {
        path: SESSION_PATH,
        error_detail: 'ENOENT: session.json removed during read',
      });
      throw new Error(
        `CONVERGENCE_SESSION_PARSE_FAILED: gate=${gateName}, ` +
        `error_detail=session.json removed during read`
      );
    }

    // Create convergence object if it doesn't exist (backward compatibility)
    if (!session.convergence) {
      session.convergence = {};
    }
    if (!session.convergence[gateName]) {
      session.convergence[gateName] = {};
    }

    // Legacy session detection.
    // Check BEFORE the || [] fallback -- the fallback collapses "key missing" (legacy)
    // and "key present, empty array" (new session) into the same value.
    // Legacy sessions must fail-closed with a distinct error message.
    const evidenceForGate = session.convergence_evidence?.[gateName]?.passes;
    if (evidenceForGate == null) {
      throw new Error(
        `CONVERGENCE_VERIFY_FAILED: cannot verify convergence: no evidence records found for gate ${gateName}. ` +
        `Record passes via record-pass before calling update-convergence.`
      );
    }

    // AC-2.1, AC-2.5 (sg-workflow-convergence-bugs ws-counter-derivation):
    // Derive BOTH clean_pass_count AND iteration_count from evidence via the
    // tail-walk reducer. Pre-fix behavior double-counted iteration_count
    // because recordPass() incremented on write AND update-convergence
    // incremented on derivation (2x inflation, Bug A). Post-fix: both counters
    // are DERIVED from passes[] as a pure read on the evidence array; no
    // write-side increment is honored here.
    // Convergence recorder tolerance AC-7: pass gateName for bound-hit
    // stderr label (preserved via the shim countConsecutiveCleanFromTail).
    const evidence = evidenceForGate;
    const sessionIdForLog = session.session_id ?? session.active_work?.spec_group_id ?? null;
    const derived = deriveConvergenceFromEvidence(evidence, gateName, sessionIdForLog);
    const cleanPassCount = derived.clean_pass_count;
    const derivedIterationCount = derived.iteration_count;

    // Preserve legacy-pollution defense warning: 200+ entries without any
    // eligible canonical record anywhere in the window emits the
    // CONVERGENCE_TAIL_WALK_BOUNDED stderr token (consumed by existing tests).
    if (Array.isArray(evidence) && evidence.length >= TAIL_WALK_BOUND) {
      const window = evidence.slice(evidence.length - TAIL_WALK_BOUND);
      const hasEligible = window.some(
        (p) =>
          p &&
          typeof p === 'object' &&
          CANONICAL_SOURCES.has(p.record_source) &&
          typeof p.clean === 'boolean',
      );
      if (!hasEligible) {
        process.stderr.write(
          `CONVERGENCE_TAIL_WALK_BOUNDED: gate=${gateName} walked ${TAIL_WALK_BOUND} ` +
          `entries without streak start, possible legacy pollution from before 2026-04-16\n`
        );
      }
    }

    // AC-2.8: Warn if >50% of passes are manual-sourced
    if (evidence.length > 0) {
      const manualCount = evidence.filter(p => p.record_source !== 'hook').length;
      if (manualCount / evidence.length > 0.5) {
        const warningMsg = `WARNING: >50% of passes for '${gateName}' are manual-sourced (${manualCount}/${evidence.length}). ` +
          `The SubagentStop hook may not be functioning correctly.`;
        console.error(warningMsg);
        // Also emit to stdout so callers using execFileSync can capture the warning
        console.log(warningMsg);
      }
    }

    session.convergence[gateName].clean_pass_count = cleanPassCount;

    // parse_failed_count surfacing semantics:
    //   - READ the existing stored value (AC1.1: "reflecting
    //     session.json.convergence.{gate}.parse_failed_count").
    //   - Derive a candidate from evidence records where
    //     record_source === 'parse_failed'.
    //   - Store MAX(existing, derived) so neither operator-set counts nor new
    //     parse-failure evidence is lost.
    //   - NFR-3: if the field was absent AND derivation is 0, do NOT write the
    //     field (no implicit rewrite; legacy records stay absent on disk).
    const derivedParseFailedCount = evidence.filter(
      p => p.record_source === 'parse_failed'
    ).length;
    const existingStoredPfc = session.convergence[gateName].parse_failed_count;
    const hasExistingField = typeof existingStoredPfc === 'number';
    const parseFailedCount = hasExistingField
      ? Math.max(existingStoredPfc, derivedParseFailedCount)
      : derivedParseFailedCount;
    if (hasExistingField || derivedParseFailedCount > 0) {
      session.convergence[gateName].parse_failed_count = parseFailedCount;
    }

    // sg-workflow-convergence-bugs (Bug A fix): iteration_count is DERIVED from
    // evidence, NOT incremented. Pre-fix code incremented here AND in recordPass
    // (double-counting -> 2x inflation). Post-fix: both iteration_count and
    // clean_pass_count are pure derivations from passes[].
    //
    // as-007 / REQ-012 / AC7.1: threshold comparison reads per-gate
    // `required_clean_passes` from the SessionThresholdSnapshot rather than
    // the legacy module-level constant. AC7.4 graceful degradation: absent
    // snapshot → fall back to the legacy constant so pre-as-005 sessions
    // behave byte-identically. AC7.3 invariant (b) preservation: the
    // comparison shape (clean_pass_count >= threshold) is unchanged; only
    // the source of `threshold` moved.
    const requiredCleanPasses = readThresholdFromSnapshot(
      session,
      gateName,
      DEFAULT_REQUIRED_CLEAN_PASSES
    );

    // as-013 / REQ-001 / AC13.1 / AC13.3 / AC13.4: attestation-skip branch.
    // When the gate carries attestation_mode='content-hash' in the
    // PerGateThresholdTable AND Pass N's persisted content_hash equals
    // Pass N-1's content_hash, collapse the effective threshold to 1 so the
    // gate marks converged on the latest clean pass without scheduling
    // Pass N+1. When the content-hash differs (EC-7) OR the gate is not
    // attested OR the pass history is insufficient, the effective
    // threshold remains the snapshot-derived `requiredCleanPasses`
    // (AC13.3 / AC13.4 byte-identical to pre-as-013 behavior).
    //
    // Safety: shouldSkipForAttestation is pure and reads only evidence +
    // the frozen PerGateThresholdTable -- it never touches disk. A SKIP
    // decision is emitted as a structured log line for audit.
    const attestationDecision = shouldSkipForAttestation(gateName, evidence);
    const attestationSkip =
      attestationDecision.decision === ATTESTATION_DECISION.SKIP;
    const effectiveRequiredCleanPasses = attestationSkip
      ? 1
      : requiredCleanPasses;
    if (attestationSkip) {
      emitDerivationLog('convergence.attestation_skip', {
        gate: gateName,
        reason: attestationDecision.reason,
        matched_hash: attestationDecision.matched_hash,
        snapshot_required_clean_passes: requiredCleanPasses,
        effective_required_clean_passes: effectiveRequiredCleanPasses,
        clean_pass_count: cleanPassCount,
      });
    } else if (
      attestationDecision.reason === 'content_hash_changed' ||
      attestationDecision.reason === 'latest_content_hash_missing' ||
      attestationDecision.reason === 'prior_content_hash_missing'
    ) {
      // EC-7 fallback: emit an audit line so operators can correlate
      // a "stuck" gate with a content-hash mismatch. Unknown/no-op reasons
      // (attestation_mode_none, insufficient_pass_history) are silent --
      // they are the expected path for non-attested gates.
      emitDerivationLog('convergence.attestation_fallback', {
        gate: gateName,
        reason: attestationDecision.reason,
        required_clean_passes: requiredCleanPasses,
        clean_pass_count: cleanPassCount,
      });
    }

    if (cleanPassCount >= effectiveRequiredCleanPasses) {
      // Convergence achieved -- reset iteration count to 0 so subsequent
      // convergence loops start fresh. Preserves the prior "reset on
      // convergence" contract tested by convergence-iteration-tracking.test.mjs
      // and consumed by auto-decision downstream.
      session.convergence[gateName].iteration_count = 0;
    } else {
      session.convergence[gateName].iteration_count = derivedIterationCount;

      // Advisory cap warning when iterations reach the limit. Uses the
      // derived count so adversary-crafted legacy records cannot force
      // a CONVERGENCE FAILURE escalation (SEC-101).
      if (derivedIterationCount >= MAX_CONVERGENCE_ITERATIONS) {
        console.error(
          `CONVERGENCE CAP REACHED for gate '${gateName}' after ${derivedIterationCount} iterations. Escalate to human.`
        );
      }
    }

    // as-013: surface the attestation decision onto the in-memory
    // convergence record so the post-write verify branch (below) can
    // apply the same threshold collapse without re-deriving. Stored on
    // the gate's convergence object rather than the session root to
    // keep scope narrow; field is additive (NFR-3 tolerant readers).
    if (attestationSkip) {
      session.convergence[gateName].attestation_skip = {
        decided_at: now(),
        matched_hash: attestationDecision.matched_hash,
      };
    } else if (session.convergence[gateName].attestation_skip) {
      // Clear stale attestation marker if the current pass history no
      // longer supports skip -- prevents a past SKIP from masking a
      // later EC-7 fallback.
      delete session.convergence[gateName].attestation_skip;
    }

    addHistoryEntry(session, 'convergence_update', {
      gate_name: gateName,
      clean_pass_count: cleanPassCount,
      parse_failed_count: parseFailedCount,
      iteration_count: session.convergence[gateName].iteration_count,
      evidence_count: evidence.length,
      spec_group_id: session.active_work?.spec_group_id,
      attestation_skip: attestationSkip,
      message: `Updated convergence: ${gateName}.clean_pass_count = ${cleanPassCount}, parse_failed_count = ${parseFailedCount}, iteration_count = ${session.convergence[gateName].iteration_count} (derived from ${evidence.length} evidence records${attestationSkip ? ', attestation-skip applied' : ''})`
    });

    session.updated_at = now();
    reportCleanPassCount = cleanPassCount;
    reportEvidenceCount = evidence.length;
    return session;
  }, { failOpen: false });

  // Task 4 (AC-6): Handle atomicModifyJSON returning false (write failure)
  if (!written) {
    throw new Error(
      `CONVERGENCE_WRITE_FAILED: atomic write to session.json failed for gate ${gateName}`
    );
  }

  // Task 2 (AC-1, AC-2, AC-3, AC-7): Post-write verification.
  // Re-read session.json from disk (fresh read, not cached reportCleanPassCount)
  // to verify the write actually persisted.
  const verifyData = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
  const verifiedCount = verifyData?.convergence?.[gateName]?.clean_pass_count ?? 0;
  // Surface parse_failed_count in CLI output. Legacy sessions without the field
  // default to 0 on read.
  const verifiedParseFailedCount =
    verifyData?.convergence?.[gateName]?.parse_failed_count ?? 0;

  // as-007 / REQ-012 / AC7.1: post-write verification threshold is also
  // snapshot-derived. `verifyData` is a fresh disk read, so we feed it into
  // the resolver to pick up any snapshot captured by this session's
  // start-work. AC7.4: absent snapshot → fall back to DEFAULT_REQUIRED_CLEAN_PASSES
  // so legacy sessions behave byte-identically.
  const verifyRequiredCleanPasses = readThresholdFromSnapshot(
    verifyData,
    gateName,
    DEFAULT_REQUIRED_CLEAN_PASSES
  );
  // as-013 / AC13.1: the write branch above (attestationSkip=true) marks the
  // gate converged at effective_required=1. The post-write verifier must
  // apply the same collapse; otherwise a snapshot-required_clean_passes=2
  // gate with attestation skip would pass the write branch and fail the
  // verify branch on the same disk state. Read the persisted
  // `attestation_skip` marker we just wrote; presence implies the write
  // branch already validated the hash equality and the threshold collapse
  // is safe to honor here.
  const verifiedAttestationSkip = Boolean(
    verifyData?.convergence?.[gateName]?.attestation_skip
  );
  const verifyEffectiveThreshold = verifiedAttestationSkip
    ? 1
    : verifyRequiredCleanPasses;
  if (verifiedCount >= verifyEffectiveThreshold) {
    // AC-2: Verification succeeded -- emit to both stderr and stdout
    // (stdout needed for callers using execFileSync which only captures stdout on exit 0)
    const message = verifiedAttestationSkip
      ? `convergence recorded and verified: ${gateName}.clean_pass_count = ${verifiedCount}, parse_failed_count = ${verifiedParseFailedCount}, attestation-skip applied`
      : `convergence recorded and verified: ${gateName}.clean_pass_count = ${verifiedCount}, parse_failed_count = ${verifiedParseFailedCount}`;
    console.error(message);
    console.log(message);

    const mirrorResult = mirrorVerifiedConvergenceToManifest(
      verifyData,
      gateName,
      verifiedCount
    );
    if (!mirrorResult.ok) {
      process.stderr.write(
        `[session-checkpoint] WARNING: verified convergence manifest mirror skipped for gate='${gateName}': ${mirrorResult.reason}\n`
      );
    }

    // as-005 / REQ-005 / AC-005.6 trigger 2 (test-pass): when the unifier
    // gate converges (first green test pass per design-doc §4.1 trigger 2),
    // clear any live test-writer-unlock for the spec-group. Idempotent —
    // subsequent unifier re-convergence events hit the AC5.3/AC5.4 no-op
    // path. Fail-soft on audit-append failure: the convergence update has
    // already persisted, so the trigger's observability is best-effort.
    if (gateName === 'unifier') {
      const tpSpecGroupId = verifyData?.active_work?.spec_group_id || null;
      if (tpSpecGroupId) {
        try {
          // Re-load via loadSession so the predicate operates on an
          // atomically-read session snapshot independent of verifyData.
          const tpSession = loadSession();
          if (tpSession) {
            const tpResult = evaluateRefenceTrigger(tpSession, tpSpecGroupId, 'test-pass');
            if (tpResult.cleared) {
              saveSession(tpSession);
            }
          }
        } catch (err) {
          console.error(
            `Warning: test-writer-unlock re-fence on unifier test-pass failed for ` +
            `'${tpSpecGroupId}': ${err && err.message}. Convergence update persists; ` +
            `unlock will clear via TTL or next trigger.`
          );
        }
      }
    }
  } else {
    // AC-1, AC-3: Verification failed -- throw structured error (caught by main handler -> exit 1)
    throw new Error(
      `CONVERGENCE_VERIFY_FAILED: session.json clean_pass_count=${verifiedCount}, expected>=${verifyEffectiveThreshold}, gate=${gateName}`
    );
  }
}

// =============================================================================
// Convergence Circuit Breaker
// =============================================================================

/**
 * Per-gate circuit-breaker threshold: at this consecutive_count, degraded_mode
 * is set to true. Recorder then skips manual_fallback writes and records
 * source='parse_failed' instead (prevents compounding contamination).
 */
const CIRCUIT_BREAKER_DEGRADED_THRESHOLD = 3;

/**
 * update-circuit-breaker - Atomically update per-gate circuit-breaker state in
 * session.json.convergence_log_failures.
 *
 * Usage:
 *   update-circuit-breaker --gate <gate> --event <failure|success>
 *
 * On --event failure:
 *   - Increments consecutive_count
 *   - Stamps last_failure_at (ISO-8601)
 *   - At consecutive_count === 3, sets degraded_mode=true and stamps entered_degraded_at
 *
 * On --event success:
 *   - Resets consecutive_count to 0
 *   - Clears degraded_mode (false)
 *   - Clears entered_degraded_at (null)
 *
 * Exit codes:
 *   0 - state updated successfully
 *   1 - filesystem error (atomic write failure)
 *   2 - invalid argument (unknown gate or event)
 *
 * Implements: AC-14 / TECH-020 / REQ-NFR-9
 */
function opUpdateCircuitBreaker(args) {
  // Parse flags
  let gateName = null;
  let event = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--gate' && i + 1 < args.length) {
      gateName = args[i + 1];
      i++;
    } else if (args[i] === '--event' && i + 1 < args.length) {
      event = args[i + 1];
      i++;
    }
  }

  // Validate arguments (exit 2 on invalid)
  if (!gateName || !VALID_CONVERGENCE_GATES.includes(gateName)) {
    process.stderr.write(
      `update-circuit-breaker: invalid --gate '${gateName}'. ` +
      `Valid gates: ${VALID_CONVERGENCE_GATES.join(', ')}\n`
    );
    process.exit(2);
  }
  if (event !== 'failure' && event !== 'success') {
    process.stderr.write(
      `update-circuit-breaker: invalid --event '${event}'. Must be 'failure' or 'success'.\n`
    );
    process.exit(2);
  }

  ensureContextDir();

  const written = atomicModifyJSON(SESSION_PATH, (currentData) => {
    let session = currentData;
    if (!session) {
      session = createEmptySession();
    }

    if (!session.convergence_log_failures) {
      session.convergence_log_failures = {};
    }
    if (!session.convergence_log_failures[gateName]) {
      session.convergence_log_failures[gateName] = {
        consecutive_count: 0,
        last_failure_at: null,
        degraded_mode: false,
        entered_degraded_at: null,
      };
    }

    const state = session.convergence_log_failures[gateName];

    if (event === 'failure') {
      state.consecutive_count = (state.consecutive_count || 0) + 1;
      state.last_failure_at = now();
      // Set degraded_mode at exactly the threshold so the entered_degraded_at
      // timestamp captures the boundary crossing.
      if (state.consecutive_count >= CIRCUIT_BREAKER_DEGRADED_THRESHOLD && !state.degraded_mode) {
        state.degraded_mode = true;
        state.entered_degraded_at = now();
      }
    } else {
      // event === 'success': atomic reset
      state.consecutive_count = 0;
      state.degraded_mode = false;
      state.entered_degraded_at = null;
    }

    session.updated_at = now();
    return session;
  }, { failOpen: false });

  if (!written) {
    process.stderr.write(
      `update-circuit-breaker: atomic write to session.json failed for gate ${gateName}\n`
    );
    process.exit(1);
  }
}

// =============================================================================
// ws-hook-firing: recordPass atomic write primitives (as-003..as-006)
// =============================================================================
//
// Contract (sg-workflow-convergence-bugs / MasterSpec contract-atomic-write-protocol):
//   - primitive: write-to-tmp + POSIX rename() on same filesystem
//   - tmp_filename_convention: "session.json.tmp.<pid>.<timestamp_ms>"
//   - symlink_defense: lstat() pre-check; O_NOFOLLOW on open; abort with
//     SESSION_JSON_SYMLINK_REFUSED on symlink target
//   - stale_tmp_sweep: post-rename sweep of session.json.tmp.* with mtime > 60s,
//     excluding just-renamed tmp; single readdir; per-file errors logged
//     (best-effort; sweep failure MUST NOT fail recordPass)
//   - mode: explicit 0o600; does NOT rely on process umask
//   - forbidden: proper-lockfile, flock, advisory locks, multi-process locking
//
// Structured log contract (MasterSpec contract-structured-log-keys):
//   - convergence.record_pass_failed {gate, agent_type, error}
//   - error field: ExceptionClass + truncated message (<= 200 chars); no stack
//
// NFR-17/R-005 streaming-append invariant: the helper reads existing session
// bytes, delegates mutation to a caller-provided modifier, then writes the
// result. Preservation of existing passes[] bytes is a responsibility of the
// modifier callback (which must NOT re-order or re-serialize existing entries);
// the helper does not re-serialize prior entries itself.

/** Error code for symlink-refusal abort path (contract-atomic-write-protocol). */
export const SESSION_JSON_SYMLINK_REFUSED = 'SESSION_JSON_SYMLINK_REFUSED';

/** Tmp file mode: owner read/write only. Explicit numeric literal; NOT umask-dependent. */
const SESSION_JSON_TMP_MODE = 0o600;

/** Stale-tmp sweep mtime threshold (seconds). */
const STALE_TMP_SWEEP_THRESHOLD_SEC = 60;

/** Tmp-filename prefix used by this helper; sweep filter matches against this. */
const SESSION_JSON_TMP_PREFIX = 'session.json.tmp.';

/** Max chars for `error` field in convergence.record_pass_failed log line. */
const RECORD_PASS_ERROR_TRUNCATE_CHARS = 200;

/**
 * Typed error class for recordPass write-path failures. Exposes `.code` for
 * downstream log emission; attaches optional `cause` to preserve origin error
 * for stderr stack-trace diagnostics (stack traces are NOT part of the
 * structured log payload per §Security Considerations).
 *
 * @see contract-atomic-write-protocol.error_codes
 */
export class RecordPassError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'RecordPassError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Emit `convergence.record_pass_failed` structured log line per
 * contract-structured-log-keys. Written to stderr as a single JSON line
 * (NDJSON-style) so downstream observability pipelines can pick up the key.
 *
 * Bounded `error` field: <ClassName>: <truncated message>, total <= 200 chars,
 * no stack trace.
 *
 * @see as-006 AC6.1..AC6.3
 */
function emitRecordPassFailedLog(opts) {
  const { gate, agentType, err } = opts;
  const errClass = (err && err.name) || 'Error';
  const errMessage = (err && typeof err.message === 'string') ? err.message : String(err);
  const errCode = (err && typeof err.code === 'string') ? err.code + ': ' : '';
  let errField = `${errClass}: ${errCode}${errMessage}`;
  if (errField.length > RECORD_PASS_ERROR_TRUNCATE_CHARS) {
    errField = errField.slice(0, RECORD_PASS_ERROR_TRUNCATE_CHARS);
  }
  const line = JSON.stringify({
    event: 'convergence.record_pass_failed',
    gate: gate || 'unknown',
    agent_type: agentType || 'unknown',
    error: errField,
  });
  process.stderr.write(line + '\n');
}

/**
 * Best-effort unlink of a tmp file path; swallows errors so callers can
 * safely invoke on error paths without altering their throw semantics.
 */
function unlinkTmpQuiet(path) {
  try {
    unlinkSync(path);
  } catch {
    // File may already be gone (fast-path rename, or parallel sweep); ignore.
  }
}

/**
 * Post-rename stale-tmp sweep (as-005).
 *
 * Bounded: single readdir on the target's directory; filter by prefix + mtime
 * threshold; excludes the just-renamed tmp by basename comparison. Per-file
 * errors are logged to stderr but never propagated — sweep failure MUST NOT
 * fail the parent recordPass() (primary write already succeeded).
 *
 * @param {string} targetDir - Directory containing session.json (not recursed).
 * @param {string} justRenamedTmpBasename - Basename of the tmp that just became
 *   session.json; excluded from the sweep even if it still matches the prefix.
 */
function sweepStaleTmps(targetDir, justRenamedTmpBasename) {
  let entries;
  try {
    entries = readdirSync(targetDir);
  } catch (err) {
    // Directory unreadable: not worth failing the already-succeeded write for.
    process.stderr.write(
      `[session-checkpoint] WARNING: stale-tmp sweep skipped -- readdir failed: ${err.code || err.message}\n`
    );
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  for (const name of entries) {
    if (!name.startsWith(SESSION_JSON_TMP_PREFIX)) continue;
    if (name === justRenamedTmpBasename) continue; // exclude just-renamed tmp
    const fullPath = join(targetDir, name);
    try {
      const st = statSync(fullPath);
      const mtimeSec = Math.floor(st.mtimeMs / 1000);
      if (nowSec - mtimeSec <= STALE_TMP_SWEEP_THRESHOLD_SEC) {
        // Fresh tmp (possibly a concurrent in-flight write); leave alone.
        continue;
      }
      unlinkSync(fullPath);
    } catch (err) {
      // Per-file failure: continue sweeping remaining candidates.
      process.stderr.write(
        `[session-checkpoint] WARNING: stale-tmp sweep: failed on ${name}: ${err.code || err.message}\n`
      );
    }
  }
}

/**
 * Inline atomic read-modify-write used by recordPass() (as-003..as-005).
 *
 * Differences from the shared `atomicModifyJSON` helper:
 *   - Tmp filename includes timestamp (NFR-20 contract: <pid>.<timestamp_ms>).
 *   - lstat() pre-check aborts on symlink with SESSION_JSON_SYMLINK_REFUSED.
 *   - open() uses O_NOFOLLOW where supported; explicit mode 0o600.
 *   - Post-rename stale-tmp sweep (> 60s, exclude just-renamed).
 *   - No lockfile / proper-lockfile / flock (NFR-19).
 *   - On rename failure, does NOT overwrite the target with `{}` (R-005 byte
 *     preservation); tmp is left on disk (per AC-B7) and the error is thrown.
 *
 * @param {string} targetPath - Absolute path to session.json.
 * @param {function} modifier - (currentData: object|null) => object. MUST NOT
 *   re-serialize existing passes[] entries — append-only invariant.
 * @throws {RecordPassError} On symlink refusal, write failure, rename failure.
 */
function recordPassAtomicWrite(targetPath, modifier) {
  const targetDir = dirname(targetPath);
  const targetBasename = basename(targetPath);

  // Ensure directory exists (does NOT follow symlinks for existing entries).
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Symlink pre-check (as-004, AC-B-SYMLINK): lstat the target; if it's a
  // symlink, abort before opening or writing. SESSION_JSON_SYMLINK_REFUSED
  // flows to emitRecordPassFailedLog via the caller's catch path.
  if (existsSync(targetPath)) {
    let lst;
    try {
      lst = lstatSync(targetPath);
    } catch (err) {
      throw new RecordPassError(
        'SESSION_JSON_LSTAT_FAILED',
        `lstat(${targetPath}) failed: ${err.code || err.message}`,
        err
      );
    }
    if (lst.isSymbolicLink()) {
      throw new RecordPassError(
        SESSION_JSON_SYMLINK_REFUSED,
        `Refusing to write through symlink at ${targetPath}`
      );
    }
  }

  // Read current data (tolerant: corrupt / missing -> null, caller creates fresh).
  let currentData = null;
  if (existsSync(targetPath)) {
    try {
      const raw = readFileSync(targetPath, 'utf-8');
      currentData = JSON.parse(raw);
    } catch (err) {
      // Read failure: surface as structured error. recordPass catch path emits
      // convergence.record_pass_failed; process exits non-zero upstream.
      throw new RecordPassError(
        'SESSION_JSON_READ_FAILED',
        `Read/parse of ${targetPath} failed: ${err.code || err.message}`,
        err
      );
    }
  }

  const newData = modifier(currentData);
  const content = JSON.stringify(newData, null, 2) + '\n';

  // Tmp naming convention: session.json.tmp.<pid>.<timestamp_ms> (R-020).
  const tmpBasename = `${targetBasename}.tmp.${process.pid}.${Date.now()}`;
  const tmpPath = join(targetDir, tmpBasename);

  // Open with O_NOFOLLOW where supported (defense-in-depth atop lstat);
  // O_CREAT|O_WRONLY|O_TRUNC for a fresh tmp; explicit mode 0o600.
  // O_NOFOLLOW rejects symlink at final path component (POSIX/BSD behavior on
  // Darwin + Linux). Parent-dir symlink attacks are out of scope per NFR-8
  // sole-maintainer trust model.
  let fd;
  const openFlags = fsConstants.O_CREAT
    | fsConstants.O_WRONLY
    | fsConstants.O_TRUNC
    | (fsConstants.O_NOFOLLOW || 0);
  try {
    fd = openSync(tmpPath, openFlags, SESSION_JSON_TMP_MODE);
  } catch (err) {
    throw new RecordPassError(
      'SESSION_JSON_TMP_OPEN_FAILED',
      `open(${tmpPath}) failed: ${err.code || err.message}`,
      err
    );
  }

  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (err) {
    // Write failed mid-tmp (AC-B7 throw-mid-tmp): leave tmp file on disk per
    // spec (tmp abandoned, not unlinked on error path; sweep claims it later).
    try { closeSync(fd); } catch { /* ignore */ }
    throw new RecordPassError(
      'SESSION_JSON_TMP_WRITE_FAILED',
      `write(${tmpPath}) failed: ${err.code || err.message}`,
      err
    );
  }

  try {
    closeSync(fd);
  } catch (err) {
    throw new RecordPassError(
      'SESSION_JSON_TMP_CLOSE_FAILED',
      `close(${tmpPath}) failed: ${err.code || err.message}`,
      err
    );
  }

  // Atomic rename (POSIX same-filesystem rename is atomic on success).
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Rename failed: tmp remains on disk; target byte-preserved (R-005).
    // Do NOT overwrite target with {} (the shared atomic-write.mjs does this;
    // recordPass path forbids it per NFR-17).
    throw new RecordPassError(
      'SESSION_JSON_RENAME_FAILED',
      `rename(${tmpPath} -> ${targetPath}) failed: ${err.code || err.message}`,
      err
    );
  }

  // Post-rename stale-tmp sweep (best-effort; errors do not fail recordPass).
  sweepStaleTmps(targetDir, tmpBasename);
}

// =============================================================================
// recordPass: exported module-import API
// =============================================================================

/**
 * Record a convergence pass via direct module import.
 *
 * Sole module-import-only entry point for pass evidence writes. The CLI handler
 * for `record-pass` rejects every `--source` value, so any entry
 * in session.json's convergence_evidence must have come from this function call.
 *
 * The sole importer is `.claude/scripts/convergence-pass-recorder.mjs`.
 *
 * @param {Object} opts
 * @param {('hook'|'parse_failed'|'manual_fallback')} opts.source
 *   Source of the pass. The recorder module writes three legitimate values --
 *     - 'hook'            normal subagent output (all 4 extractor paths hit)
 *     - 'parse_failed'    extractor could not parse subagent output
 *                         (convergence-pass-recorder.mjs:1301, :1322)
 *     - 'manual_fallback' hook fell back to manual annotation after
 *                         session.log write failure (convergence-pass-recorder.mjs:1334)
 *   The previous operator-injection sources `manual` and `hook_manual` have
 *   been removed from both CLI and programmatic surfaces. Legacy records in
 *   existing session.json files carrying these sources remain parseable and
 *   continue to break the hook-clean streak in countConsecutiveCleanFromTail.
 * @param {string} opts.gate
 *   Convergence gate name (one of VALID_CONVERGENCE_GATES).
 * @param {boolean} opts.clean
 *   Whether the pass is clean.
 * @param {number} [opts.findingCount] - Optional finding count.
 * @param {string} [opts.findingsHash] - Optional 64-char hex hash of finding IDs.
 * @param {string} [opts.agentType] - Optional agent type (e.g. 'code-reviewer').
 * @param {string} [opts.agentId] - Optional agent instance id.
 * @param {Object} [opts.meta] - Optional additional metadata (currently ignored
 *   by the persistence layer; reserved for future audit fields).
 *
 * @returns {Promise<void>}
 * @throws {Error} On invalid source / gate / atomic-write failure.
 *
 * Current contract: programmatic recorder source enum.
 */
export async function recordPass(opts) {
  const {
    source,
    gate,
    clean,
    findingCount = null,
    findingsHash = null,
    agentType = 'unknown',
    agentId = undefined,
    meta = undefined,
  } = opts || {};

  // Validate source against the 3 legitimate hook-path sources. `manual` and `hook_manual`
  // are rejected at the programmatic layer as well -- they were
  // operator-injection surfaces with no legitimate in-process caller.
  // Byte-sync with session.schema.json:439-441 `record_source` enum.
  const validSources = ['hook', 'parse_failed', 'manual_fallback'];
  if (!validSources.includes(source)) {
    throw new Error(`INVALID_SOURCE: '${source}'. Valid sources: ${validSources.join(', ')}`);
  }

  // Validate gate
  if (!VALID_CONVERGENCE_GATES.includes(gate)) {
    throw new Error(
      `Invalid gate_name '${gate}'. Valid gate names: ${VALID_CONVERGENCE_GATES.join(', ')}`
    );
  }

  if (typeof clean !== 'boolean') {
    throw new Error('recordPass: opts.clean must be a boolean');
  }

  ensureContextDir();

  // ws-hook-firing (as-003..as-006): use inline atomic-write helper that
  // satisfies contract-atomic-write-protocol (tmp<pid>.<ts>+rename, lstat
  // symlink guard, O_NOFOLLOW, explicit mode 0o600, stale-tmp sweep, no
  // external locks). On failure, emit convergence.record_pass_failed per
  // contract-structured-log-keys and rethrow.
  //
  // R-005/NFR-17 append-only invariant: the modifier below uses passes.push()
  // and never re-serializes prior entries individually — JSON.stringify(session, null, 2)
  // deterministically preserves the order and structure of existing entries.
  // NFR-21 immutability: this path does NOT read or write the session workflow field.
  try {
    recordPassAtomicWrite(SESSION_PATH, (currentData) => {
      let session = currentData;
      if (!session) {
        session = createEmptySession();
      }
      if (!session.convergence_evidence) {
        session.convergence_evidence = {};
      }
      if (!session.convergence_evidence[gate]) {
        session.convergence_evidence[gate] = { passes: [] };
      }
      const passes = session.convergence_evidence[gate].passes;

      const nextPassNumber = passes.length > 0
        ? passes[passes.length - 1].pass_number + 1
        : 1;

      const record = {
        pass_number: nextPassNumber,
        timestamp: now(),
        agent_type: agentType,
        findings_count: findingCount,
        findings_hash: findingsHash,
        clean,
        record_source: source,
      };
      if (agentId !== undefined) record.agent_id = agentId;
      if (meta !== undefined) record.meta = meta;

      // as-013 / AC13.2: persist content_hash on content-hash-attested
      // gates so the attestation-skip branch at derive time can compare
      // Pass N vs Pass N-1 (AC13.1) or fall back to consecutive counting
      // (EC-7, AC13.3). The module-export recordPass() path is the one
      // exercised by the SubagentStop hook in production; the CLI handler
      // opRecordPass is the manual/debug entry point. Both paths must
      // persist the field identically so operator-invoked traces are
      // interchangeable with hook-emitted traces.
      if (gateUsesContentHashAttestation(gate)) {
        const contentHash = computeGateContentHashOrNull(gate, session);
        if (typeof contentHash === 'string' && contentHash.length > 0) {
          record.content_hash = contentHash;
        }
      }

      passes.push(record);

      if (!session.convergence) session.convergence = {};
      if (!session.convergence[gate]) session.convergence[gate] = { clean_pass_count: 0 };
      const currentIterations = session.convergence[gate].iteration_count || 0;
      session.convergence[gate].iteration_count = currentIterations + 1;

      // Append to sources[] whenever meta carries a parse_failed_reason (or any record_source we track
      // in the two-store convergence model). Entries are additive; readers that
      // do not understand the field tolerate absence (NFR-3).
      if (meta && typeof meta === 'object' && meta.parse_failed_reason !== undefined) {
        if (!Array.isArray(session.convergence[gate].sources)) {
          session.convergence[gate].sources = [];
        }
        session.convergence[gate].sources.push({
          record_source: source === 'hook' ? 'hook' : source,
          parse_failed: source === 'parse_failed',
          parse_failed_reason: meta.parse_failed_reason,
          timestamp: now(),
          pass_number: nextPassNumber,
        });
      }

      addHistoryEntry(session, 'convergence_pass_recorded', {
        gate_name: gate,
        pass_number: nextPassNumber,
        clean,
        record_source: source,
        agent_type: agentType,
        message: `Recorded pass ${nextPassNumber} for ${gate}: clean=${clean}, source=${source}`,
      });

      // last_pass_history_index invariant: the just-appended convergence_pass_recorded
      // entry is at index session.history.length - 1. Both the history.push and this
      // index assignment run inside the same recordPassAtomicWrite transaction so
      // either both writes commit or both roll back (pass-recording atomicity).
      //
      // Hook-not-firing graceful degradation (AC-8.4): this invariant is written
      // ONLY when recordPass() is invoked (sole caller: convergence-pass-recorder.mjs
      // PostToolUse hook). If the hook never fires for a gate, the field stays
      // undefined, EC-14 trigger in reconcileConvergenceFromManifest fails its
      // `!== undefined` precondition, and reconcile falls back to legacy behavior.
      // This is intentional safe-default degradation; EC-14 is additive protection
      // that only activates when recent pass evidence is actually recorded.
      session.convergence[gate].last_pass_history_index = session.history.length - 1;

      session.updated_at = now();
      return session;
    });
  } catch (err) {
    // as-006: structured log emission on write-path failure.
    emitRecordPassFailedLog({ gate, agentType, err });
    // Propagate so the SubagentStop hook exits non-zero (AC-B6).
    // Note: recordPassAtomicWrite throws on every failure path (symlink, open,
    // write, rename); catching+rethrowing here subsumes the prior
    // `if (!written) throw` guard from the atomicModifyJSON shape.
    throw err;
  }
}

// =============================================================================
// Deployment Verification
// =============================================================================

/** Valid deployment method values (enum, not freeform). AC-1.2 */
const VALID_DEPLOYMENT_METHODS = ['pipeline', 'manual'];

/** Regex for deployment target validation: alphanumeric plus . - / : only */
const DEPLOYMENT_TARGET_PATTERN = /^[a-zA-Z0-9.\-/:]+$/;

/** Maximum length for deployment target string */
const DEPLOYMENT_TARGET_MAX_LENGTH = 256;

/**
 * Validate deployment target string.
 * Must be alphanumeric plus . - / : only, max 256 chars. (AC-1.2, REQ-007)
 *
 * @param {string} target - Deployment target identifier
 * @returns {{ valid: boolean, error?: string }}
 */
function validateDeploymentTarget(target) {
  if (!target || typeof target !== 'string') {
    return { valid: false, error: 'Deployment target is required and must be a string' };
  }
  if (target.length > DEPLOYMENT_TARGET_MAX_LENGTH) {
    return { valid: false, error: `Deployment target exceeds ${DEPLOYMENT_TARGET_MAX_LENGTH} characters (got ${target.length})` };
  }
  if (!DEPLOYMENT_TARGET_PATTERN.test(target)) {
    return { valid: false, error: `Deployment target contains invalid characters. Allowed: alphanumeric, '.', '-', '/', ':'` };
  }
  return { valid: true };
}

/**
 * Validate deployment method against enum.
 * Must be one of: "pipeline", "manual". (AC-1.2, inv-7-a3f1c2d8)
 *
 * @param {string} method - Deployment method
 * @returns {{ valid: boolean, error?: string }}
 */
function validateDeploymentMethod(method) {
  if (!VALID_DEPLOYMENT_METHODS.includes(method)) {
    return { valid: false, error: `Invalid deployment method '${method}'. Must be one of: ${VALID_DEPLOYMENT_METHODS.join(', ')}` };
  }
  return { valid: true };
}

/**
 * record-deployment - Record deployment activity in session.json.
 *
 * Overwrites entire prior deployment object (clean slate per AC-1.3).
 * Uses atomicModifyJSON for all writes (AC-7.1).
 *
 * Implements: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-7.1
 *
 * @param {string[]} rawArgs - Arguments after 'record-deployment'
 */
async function opRecordDeployment(rawArgs) {
  // Parse flags: --target <target> --method <method> --manual
  let target = null;
  let method = 'pipeline'; // default
  let isManual = false;

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--target' && i + 1 < rawArgs.length) {
      target = rawArgs[i + 1];
      i++;
    } else if (rawArgs[i] === '--method' && i + 1 < rawArgs.length) {
      method = rawArgs[i + 1];
      i++;
    } else if (rawArgs[i] === '--manual') {
      isManual = true;
    }
  }

  // AC-1.4: --manual flag sets method to "manual"
  if (isManual) {
    method = 'manual';
  }

  // Validate target (AC-1.2)
  const targetValidation = validateDeploymentTarget(target);
  if (!targetValidation.valid) {
    throw new Error(targetValidation.error);
  }

  // Validate method (AC-1.2, inv-7-a3f1c2d8: enum constraint)
  const methodValidation = validateDeploymentMethod(method);
  if (!methodValidation.valid) {
    throw new Error(methodValidation.error);
  }

  // AC-14.1, AC-14.2: Compute env hash from manifest allowlist if available
  let expectedEnvHash = null;
  let serviceName = null;
  try {
    // Parse --service flag from rawArgs for manifest lookup
    for (let j = 0; j < rawArgs.length; j++) {
      if (rawArgs[j] === '--service' && j + 1 < rawArgs.length) {
        serviceName = rawArgs[j + 1];
        break;
      }
    }

    if (serviceName) {
      const { loadDeploymentManifest, envHashCanonicalize } = await import('./lib/deployment-verify.mjs');
      const manifestResult = loadDeploymentManifest(serviceName);
      if (manifestResult.success && manifestResult.data.deployment_env_allowlist?.length > 0) {
        expectedEnvHash = envHashCanonicalize(manifestResult.data.deployment_env_allowlist, process.env);
      } else if (!manifestResult.success || !manifestResult.data.deployment_env_allowlist?.length) {
        process.stderr.write(JSON.stringify({
          event: 'env_hash_skipped',
          warning: 'No env allowlist declared -- env state reconciliation skipped',
          timestamp: now(),
          service: serviceName,
        }) + '\n');
      }
    }
  } catch {
    // AC-14.2: Fail-open -- set null and warn
    process.stderr.write('[session-checkpoint] WARNING: Failed to compute env hash -- setting to null\n');
  }

  // AC-1.1, AC-1.3: Write deployment object via atomicModifyJSON (AC-7.1)
  // Overwrites entire prior deployment object (clean slate)
  atomicModifyJSON(SESSION_PATH, (current) => {
    const s = current || {};

    // AC-1.1: Set deployment object with all fields
    s.deployment = {
      detected: true,
      timestamp: now(),
      target,
      method,
      verified: false,
      verify_build_passed: false,
      verify_deploy_passed: false,
      failed: false,
      expected_env_hash: expectedEnvHash,
    };

    s.updated_at = now();
    return s;
  }, { failOpen: false });

  // AC-8: Structured audit log to stderr
  const auditEntry = {
    event: 'deployment_recorded',
    result: 'PASS',
    timestamp: now(),
    target,
    method,
    expected_env_hash: expectedEnvHash,
  };
  process.stderr.write(JSON.stringify(auditEntry) + '\n');
  console.error(`Deployment recorded: target=${target}, method=${method}`);
}

/**
 * record-deployment-failure - Record deployment failure in session.json.
 *
 * Sets deployment.failed=true via atomicModifyJSON. (AC-2.1, AC-7.1)
 * When failed=true, stop hook skips verification requirement (AC-2.2).
 *
 * Precondition: deployment.detected should be true (warn if not).
 *
 * Implements: AC-2.1, AC-7.1
 */
function opRecordDeploymentFailure() {
  atomicModifyJSON(SESSION_PATH, (current) => {
    const s = current || {};

    // Warn if no prior deployment detected (precondition)
    if (!s.deployment || !s.deployment.detected) {
      process.stderr.write(
        '[session-checkpoint] WARNING: record-deployment-failure called without prior deployment detection\n'
      );
      // Still set the failed flag -- create a minimal deployment object
      s.deployment = s.deployment || {
        detected: false,
        timestamp: now(),
        target: 'unknown',
        method: 'pipeline',
        verified: false,
        verify_build_passed: false,
        verify_deploy_passed: false,
        failed: false,
      };
    }

    // AC-2.1: Set failed=true (absolute precedence per AC-2.2)
    s.deployment.failed = true;
    s.updated_at = now();
    return s;
  }, { failOpen: false });

  // AC-8: Structured audit log to stderr
  const auditEntry = {
    event: 'deployment_failure_recorded',
    result: 'FAIL',
    timestamp: now(),
  };
  process.stderr.write(JSON.stringify(auditEntry) + '\n');
  console.error('Deployment failure recorded: deployment.failed=true');
}

/**
 * record-deployment-clear-failure - Clear deployment.failed after env state reconciliation.
 *
 * Compares current env hash against deployment.expected_env_hash.
 * On match: clears deployment.failed, appends PASS entry to audit log.
 * On divergence: blocks unless --signed-record provided.
 *
 * Implements: AC-14.3, AC-14.4, AC-14.5, AC-14.6, AC-14.8
 *
 * @param {string[]} rawArgs - Arguments after 'record-deployment-clear-failure'
 */
async function opRecordDeploymentClearFailure(rawArgs) {
  // Parse flags
  let serviceName = null;
  let signedRecordPath = null;

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--service' && i + 1 < rawArgs.length) {
      serviceName = rawArgs[i + 1];
      i++;
    } else if (rawArgs[i] === '--signed-record' && i + 1 < rawArgs.length) {
      signedRecordPath = rawArgs[i + 1];
      i++;
    }
  }

  if (!serviceName) {
    throw new Error('--service <name> is required for record-deployment-clear-failure');
  }

  // Load current session state
  const session = loadSession();
  if (!session?.deployment) {
    throw new Error('No deployment object in session.json');
  }

  const expectedHash = session.deployment.expected_env_hash;

  // AC-14.2: No hash captured -- cannot reconcile
  if (expectedHash === null || expectedHash === undefined) {
    process.stderr.write(JSON.stringify({
      event: 'clear_failure_skipped',
      warning: 'No expected_env_hash in session -- clearing failed without reconciliation',
      timestamp: now(),
      service: serviceName,
    }) + '\n');

    atomicModifyJSON(SESSION_PATH, (current) => {
      const s = current || {};
      if (s.deployment) {
        s.deployment.failed = false;
      }
      s.updated_at = now();
      return s;
    }, { failOpen: false });

    console.error('deployment.failed cleared (no env hash to reconcile)');
    return;
  }

  // AC-14.3: Re-read current env and re-compute hash
  // M1 fix: computeDivergentKeys removed -- not usable without deploy-time env snapshot.
  const { loadDeploymentManifest, envHashCanonicalize } = await import('./lib/deployment-verify.mjs');
  const manifestResult = loadDeploymentManifest(serviceName);

  if (!manifestResult.success) {
    throw new Error(`Cannot load manifest for service '${serviceName}': ${manifestResult.error?.message || 'unknown'}`);
  }

  const allowlist = manifestResult.data.deployment_env_allowlist || [];
  const actualHash = envHashCanonicalize(allowlist, process.env);

  // Compute divergent keys for structured reporting
  // Build expected env snapshot from the hash -- we only have the hash, not the snapshot
  // AC-14.5: divergent-key reporting requires env snapshot at deploy-time (not just hash).
  // Deferred -- hash-only comparison is sufficient for v1. See spec D-016.
  const hashesMatch = expectedHash === actualHash;

  if (hashesMatch) {
    // AC-14.4: Match => PASS, clear deployment.failed
    atomicModifyJSON(SESSION_PATH, (current) => {
      const s = current || {};
      if (s.deployment) {
        s.deployment.failed = false;
      }
      s.updated_at = now();
      return s;
    }, { failOpen: false });

    // Append PASS entry to audit log
    const { appendAuditLogEntry } = await import('./lib/deployment-audit.mjs');
    await appendAuditLogEntry({
      operator: process.env.USER || 'unknown',
      correlation_id: session.deployment?.timestamp || now(),
      payload: {
        kind: 'clear-failure-pass',
        service: serviceName,
        expected_env_hash: expectedHash,
        actual_env_hash: actualHash,
        divergent_keys: [],
        maintainer_rationale: '',
      },
    });

    process.stderr.write(JSON.stringify({
      event: 'clear_failure_pass',
      result: 'PASS',
      timestamp: now(),
      service: serviceName,
      expected_hash: expectedHash,
      actual_hash: actualHash,
    }) + '\n');
    console.error('deployment.failed cleared -- env hash matches');
    return;
  }

  // AC-14.5: Divergence detected
  // We cannot reconstruct the original env values from just the hash,
  // so divergent keys are reported as empty unless we add env snapshot tracking (future)
  const divergentKeys = [];

  if (!signedRecordPath) {
    // AC-14.5: Block without signed record
    const { appendAuditLogEntry } = await import('./lib/deployment-audit.mjs');
    await appendAuditLogEntry({
      operator: process.env.USER || 'unknown',
      correlation_id: session.deployment?.timestamp || now(),
      payload: {
        kind: 'clear-failure-divergence-blocked',
        service: serviceName,
        expected_env_hash: expectedHash,
        actual_env_hash: actualHash,
        divergent_keys: divergentKeys,
        maintainer_rationale: '',
      },
    });

    process.stderr.write(JSON.stringify({
      event: 'clear_failure_blocked',
      result: 'BLOCKED',
      timestamp: now(),
      service: serviceName,
      payload: {
        expected_hash: expectedHash,
        actual_hash: actualHash,
        divergent_keys: divergentKeys,
        timestamp: now(),
        service: serviceName,
      },
    }) + '\n');

    throw new Error(
      `Env hash divergence detected. Expected: ${expectedHash}, Actual: ${actualHash}. ` +
      'Commit a signed record to `.claude/audit/deployment-interventions.log` acknowledging the divergence.'
    );
  }

  // AC-14.6: Signed record provided -- validate and clear
  // F-4 fix: Validate signed record path is within .claude/ project boundary
  // to prevent arbitrary file reads via --signed-record flag.
  const resolvedRecordPath = resolve(signedRecordPath);
  const claudeAuditPrefix = resolve('.claude') + sep;
  if (!resolvedRecordPath.startsWith(claudeAuditPrefix)) {
    throw new Error(
      `Signed record path must be within .claude/ directory. Got: ${signedRecordPath}`
    );
  }

  // Read the signed record for maintainer_rationale
  let rationale = '';
  try {
    const recordContent = readFileSync(resolvedRecordPath, 'utf-8');
    // Extract maintainer_rationale from the record
    const rationaleMatch = recordContent.match(/maintainer_rationale:\s*(.+)/);
    rationale = rationaleMatch ? rationaleMatch[1].trim() : '';
  } catch {
    throw new Error(`Cannot read signed record at '${signedRecordPath}'`);
  }

  if (rationale.length < 50) {
    throw new Error(`maintainer_rationale must be >= 50 characters (got ${rationale.length})`);
  }

  // Clear deployment.failed
  atomicModifyJSON(SESSION_PATH, (current) => {
    const s = current || {};
    if (s.deployment) {
      s.deployment.failed = false;
    }
    s.updated_at = now();
    return s;
  }, { failOpen: false });

  // Append signed-intervention entry to audit log
  const { appendAuditLogEntry } = await import('./lib/deployment-audit.mjs');
  await appendAuditLogEntry({
    operator: process.env.USER || 'unknown',
    correlation_id: session.deployment?.timestamp || now(),
    payload: {
      kind: 'signed-intervention',
      service: serviceName,
      expected_env_hash: expectedHash,
      actual_env_hash: actualHash,
      divergent_keys: divergentKeys,
      maintainer_rationale: rationale,
    },
  });

  process.stderr.write(JSON.stringify({
    event: 'clear_failure_signed_intervention',
    result: 'PASS',
    timestamp: now(),
    service: serviceName,
    expected_hash: expectedHash,
    actual_hash: actualHash,
    maintainer_rationale_length: rationale.length,
  }) + '\n');
  console.error('deployment.failed cleared via signed intervention');
}

// =============================================================================
// verify subcommand for completion-invariant checks
// =============================================================================

/** Regex for valid spec group id (SEC-001 parity). */
const SPEC_GROUP_ID_RE = /^sg-[a-z0-9.-]+$/;

/**
 * Resolve the target spec group id for `verify`.
 *
 * Priority: --spec-group flag > session.active_work.spec_group_id.
 * Returns { specGroupId, source } or { error } on resolution failure.
 *
 * @param {string[]} rawArgs
 * @param {object|null} session
 * @returns {{specGroupId?: string, source?: string, error?: string}}
 */
function resolveVerifyTarget(rawArgs, session) {
  let flagValue = null;
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--spec-group' && i + 1 < rawArgs.length) {
      flagValue = rawArgs[i + 1];
      i++;
    }
  }

  if (flagValue !== null) {
    if (!SPEC_GROUP_ID_RE.test(flagValue)) {
      return { error: `Invalid spec group id format: ${flagValue}` };
    }
    return { specGroupId: flagValue, source: 'flag' };
  }

  const sessionSgId = session?.active_work?.spec_group_id;
  if (typeof sessionSgId === 'string' && sessionSgId.length > 0) {
    if (!SPEC_GROUP_ID_RE.test(sessionSgId)) {
      return { error: `Invalid spec_group_id in session: ${sessionSgId}` };
    }
    return { specGroupId: sessionSgId, source: 'session' };
  }

  return { error: 'no active spec group and --spec-group not provided' };
}

/**
 * verify — run the five completion-invariant checks locally.
 *
 * Reads session.json and the target spec group's manifest.json, invokes the
 * five check functions from lib/stop-hook-checks.mjs, and prints a
 * human-readable PASS/FAIL summary. Exit 0 on clean, 1 on any failure or
 * resolution error. Read-only (no session.json writes, no heartbeat reset).
 *
 * Respects the kill switch and exempt workflows: prints an "enforcement
 * disabled" message and exits 0 instead of running the checks.
 *
 * @param {string[]} rawArgs - Arguments after 'verify'
 */
function opVerify(rawArgs) {
  // Kill switch: enforcement disabled -> exit 0 with informational message.
  const killSwitchPath = join(CLAUDE_DIR, 'coordination', 'gate-enforcement-disabled');
  if (existsSync(killSwitchPath)) {
    console.log('verify: enforcement disabled (kill switch active)');
    process.exit(0);
  }

  // Load session (optional: some invocations have --spec-group and no active session).
  const session = loadSession();

  // Exempt workflow: print informational and exit 0.
  if (session) {
    const workflow = getWorkflowTypeStrict(session);
    if (workflow && isExemptWorkflow(workflow)) {
      console.log(`verify: enforcement disabled (exempt workflow: ${workflow})`);
      process.exit(0);
    }
  }

  // Resolve target spec group.
  const resolution = resolveVerifyTarget(rawArgs, session);
  if (resolution.error) {
    process.stderr.write(`${resolution.error}\n`);
    process.exit(1);
  }
  const { specGroupId, source } = resolution;

  // Construct paths and load manifest.
  const specGroupDir = join(CLAUDE_DIR, 'specs', 'groups', specGroupId);
  if (!existsSync(specGroupDir)) {
    process.stderr.write(`Spec group not found: ${specGroupId}\n`);
    process.exit(1);
  }
  const manifestPath = join(specGroupDir, 'manifest.json');
  let manifest = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      process.stderr.write(`Warning: manifest read/parse failed for ${specGroupId}: ${err.message}\n`);
      manifest = null;
    }
  } else {
    process.stderr.write(`Warning: manifest.json not found at ${manifestPath}\n`);
  }

  // Determine workflow for checks requiring it. When session is absent or
  // missing workflow, fall back to manifest.workflow; final fallback is
  // 'oneoff-spec' to keep the verify actionable without a session.
  let workflow = session ? getWorkflowTypeStrict(session) : null;
  if (!workflow && manifest && typeof manifest.workflow === 'string') {
    workflow = manifest.workflow;
  }
  if (!workflow) {
    workflow = 'oneoff-spec';
  }

  // Run all five checks (session-checkpoint verify uses a best-effort session:
  // if session.json is missing, pass an empty-ish object to the checks so they
  // still emit meaningful failures rather than throwing).
  const runtimeSession = session || {};
  const results = {
    convergenceDepth: checkConvergenceDepth(runtimeSession, manifest),
    challengerStages: checkChallengerStages(runtimeSession, workflow),
    phaseDag: checkPhaseDagPredecessors(runtimeSession, workflow),
    artifactInventory: checkArtifactInventory(specGroupDir, workflow),
    convergenceFieldSanity: checkConvergenceFieldSanity(runtimeSession, manifest),
  };

  // Build human-readable summary. Deterministic ordering for diff-based pins.
  const lines = [];
  lines.push(`verify: spec group ${specGroupId} (source: ${source}, workflow: ${workflow})`);

  const orderedChecks = [
    ['Convergence depth (REQ-001/002/003/012)', 'convergenceDepth', formatConvergenceDepthFailure],
    ['Challenger stages (REQ-004/005/006)', 'challengerStages', formatChallengerStagesFailure],
    ['Phase DAG predecessors (REQ-007/008)', 'phaseDag', formatPhaseDagFailure],
    ['Artifact inventory (REQ-009/010)', 'artifactInventory', formatArtifactInventoryFailure],
    ['Convergence-field sanity (REQ-011)', 'convergenceFieldSanity', formatConvergenceSanityFailure],
  ];

  let anyFailed = false;
  for (const [label, key, formatter] of orderedChecks) {
    const r = results[key];
    if (r.passed) {
      lines.push(`  PASS  ${label}`);
    } else {
      anyFailed = true;
      lines.push(`  FAIL  ${label}`);
      for (const failure of r.failures) {
        // Only formatArtifactInventoryFailure needs specGroupDir; the others
        // take the optional `prefix` arg in that slot (defaulted to '').
        const rendered =
          key === 'artifactInventory'
            ? formatter(failure, specGroupDir)
            : formatter(failure);
        lines.push(`          ${rendered}`);
      }
    }
  }

  if (anyFailed) {
    lines.push('');
    lines.push('Overall: FAIL');
    console.log(lines.join('\n'));
    process.exit(1);
  } else {
    lines.push('');
    lines.push('Overall: PASS');
    console.log(lines.join('\n'));
    process.exit(0);
  }
}

// =============================================================================
// as-021: Baseline-override lock inspect + force-release (REQ-011 / F3)
// =============================================================================

/**
 * Resolve the canonical baseline-override lock path for the current project.
 * Single source of truth — do NOT inline elsewhere.
 *
 * sg-pipeline-efficiency-ws1-convergence-pruning / as-021 / AC21.4:
 * lock lives under `<claude_dir>/coordination/baseline-override.lock`.
 *
 * Resolution precedence (test-isolation honoured):
 *   1. `CLAUDE_PROJECT_DIR` env var — points to a project ROOT (contains
 *      `.claude/`). Used by inspect-lock integration tests that run the
 *      checkpoint script against a tmpdir project root.
 *   2. Script-local `CLAUDE_DIR` (absolute path discovered at module init).
 *
 * SELF-RESOLVED(code): `CLAUDE_PROJECT_DIR` is the project ROOT directory
 * (contains `.claude/`), not the `.claude/` directory itself. Authoritative
 * evidence — all in-repo:
 *   - `dispatch-record-hook.mjs:213` explicitly sets
 *     `CLAUDE_PROJECT_DIR: dirname(claudeDir)` when spawning the
 *     session-checkpoint CLI, which by construction is the parent of
 *     `.claude/`.
 *   - `pipeline-efficiency-audit-log.mjs:123` uses
 *     `process.env.CLAUDE_PROJECT_DIR || process.cwd()` as the project
 *     root for `.claude/audit/` path resolution — identical convention
 *     to the fallback directly below (`join(CLAUDE_DIR, ...)`, where
 *     `CLAUDE_DIR` is `<project_root>/.claude`).
 *   - `.claude/docs/HOOKS.md:48` documents `CLAUDE_PROJECT_DIR` as
 *     "Project root directory" for all hooks.
 *   - `.claude/docs/ENFORCEMENT-FLOW.md:196`, `reverse-governance-monitor.mjs:165`,
 *     and `test-baseline-check.mjs:63` all consume the same convention
 *     (`env.CLAUDE_PROJECT_DIR || process.cwd()` as project-root).
 * The join(projectDir, '.claude', 'coordination', ...) below is therefore
 * structurally correct under the canonical convention.
 */
function baselineOverrideLockPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir && typeof projectDir === 'string' && projectDir.length > 0) {
    return join(projectDir, '.claude', 'coordination', 'baseline-override.lock');
  }
  return join(CLAUDE_DIR, 'coordination', 'baseline-override.lock');
}

/**
 * Emit a baseline-override force-release audit-log entry.
 *
 * AC21.5: all force-releases SHALL be audit-logged.
 *
 * sg-pipeline-efficiency-ws1-convergence-pruning / as-027 / Task I3 (stub swap):
 * as-021 shipped with a stderr stub because as-017 (`appendAuditEntry`) had
 * not yet landed. as-017 is now live — this function calls the real appender.
 *
 * Event-class mapping: the 9-class canonical enum (lib/schemas/audit-entry.schema.mjs:79-102)
 * does NOT include `baseline_override_lock`. Per as-027 dispatcher guidance,
 * baseline-override force-release events fold into `session_override_flip`
 * with the event_subtype `baseline_override_force_release` carrying the
 * distinguishing semantic. This preserves the as-021 design intent while
 * conforming to the shipped enum (NFR-5).
 *
 * Failure handling: AuditLogError is caught locally so a broken audit chain
 * never prevents the lock release from being recorded to stdout. Callers
 * (opInspectLock) already complete the user-visible release before this
 * returns; a silent stderr diagnostic is emitted on audit failure so the
 * operator sees the chain problem without the CLI exiting non-zero from a
 * peripheral logging path (AC21.5 is "audit-logged" — chain corruption is a
 * separate incident surfaced by verify-audit-chain).
 *
 * @param {object} payload — structured event body (canonical-JSON-safe).
 * @returns {{ seq: number | null, ok: boolean, error: string | null }}
 */
function auditForceReleaseStub(payload) {
  try {
    const { seq } = appendAuditEntry(
      'session_override_flip',
      'baseline_override_force_release',
      payload,
    );
    return { seq, ok: true, error: null };
  } catch (err) {
    // AuditLogError has a `.code` field; non-AuditLogError falls back to .message.
    const code = err && err.code ? err.code : 'E_AUDIT_APPEND_FAILED';
    process.stderr.write(
      `[session-checkpoint] WARN: baseline_override_force_release audit append failed: ${code} — ${err.message}\n`,
    );
    return { seq: null, ok: false, error: code };
  }
}

/**
 * `inspect-lock baseline-override [--force-release --rationale "<r>"]` CLI op.
 *
 * Dual-mode:
 *   - Without `--force-release`: read-only inspection per AC21.4.
 *   - With `--force-release`: audit-logged release per AC21.5.
 *
 * AC21.4 — inspection:
 *   - Absent lock → exit 0, human-friendly "no lock held" message plus
 *     structured JSON (key `age` present, value `null`).
 *   - Held lock → exit 0; JSON carries `{pid, workstream_id, acquired_at, age_ms}`.
 *   - Corrupt lock → exit 1.
 *
 * AC21.5 — force-release:
 *   - Rationale missing or empty → exit 1 (rationale required).
 *   - Absent lock → exit 0, no-op.
 *   - Fresh lock (< 15 min) with rationale `STALE_LOCK_RECOVERY` → exit 1
 *     (canonical stale rationale must not be used on a non-stale lock).
 *   - Stale lock (≥ 15 min) with rationale `STALE_LOCK_RECOVERY` → accepted,
 *     audit-logged, lock file removed.
 *   - Any lock state with a non-stale generic rationale: accepted only when
 *     the lock is stale; if the lock is fresh, reject to avoid accidental
 *     concurrent-writer preemption.
 *
 * @param {object} parsed — { lockName, forceRelease, rationale }.
 */
function opInspectLock(parsed) {
  const { lockName, forceRelease, rationale } = parsed;

  if (lockName !== 'baseline-override') {
    console.error(
      `inspect-lock: unknown lock name '${lockName}' — only 'baseline-override' is supported (as-021)`,
    );
    process.exit(1);
  }

  const lockPath = baselineOverrideLockPath();
  const snapshot = inspectBaselineOverrideLock(lockPath);

  // ------- Read-only inspection path (AC21.4) -------
  if (!forceRelease) {
    const out = {
      lock: 'baseline-override',
      lock_path: lockPath,
      stale_threshold_ms: STALE_LOCK_THRESHOLD_MS,
      ...snapshot,
      // Always surface an `age` field; test looks for /age/i key presence.
      age: snapshot.age_ms,
    };

    if (snapshot.classification === 'absent') {
      // Human-friendly line first for `/no lock|not held|absent|no holder/i`,
      // then structured JSON for programmatic consumers.
      console.log('no lock held (baseline-override lock is absent)');
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    }

    console.log(JSON.stringify(out, null, 2));
    if (snapshot.classification === 'corrupt') {
      process.exit(1);
    }
    process.exit(0);
  }

  // ------- force-release path (AC21.5) -------
  if (!rationale || typeof rationale !== 'string' || rationale.trim().length === 0) {
    console.error(
      '--force-release: --rationale is required (AC21.5). ' +
        `Use "${STALE_LOCK_RECOVERY}" when breaking a stale lock >15 min old.`,
    );
    process.exit(1);
  }

  const trimmedRationale = rationale.trim();

  if (snapshot.classification === 'absent') {
    console.log(
      JSON.stringify({
        lock: 'baseline-override',
        action: 'force_release',
        result: 'noop_absent',
        lock_path: lockPath,
      }),
    );
    process.exit(0);
  }

  // AC21.5 boundary: fresh lock must reject BOTH STALE_LOCK_RECOVERY (canonical
  // stale-only rationale) AND generic free-form rationales. A baseline-override
  // in active use by a concurrent writer must not be preemptable by
  // force-release; only stale locks may be broken.
  if (!snapshot.is_stale) {
    console.error(
      `--force-release: lock is not stale (age=${snapshot.age_seconds}s < ${
        STALE_LOCK_THRESHOLD_MS / 1000
      }s). ` +
        `Force-release only permitted on stale locks; current rationale='${trimmedRationale}'. ` +
        `If this is a stuck writer, wait for the stale threshold or investigate ` +
        `the lock holder (pid=${snapshot.holder && snapshot.holder.pid}).`,
    );
    process.exit(1);
  }

  const auditPayload = {
    actor: `pid:${process.pid}`,
    rationale: trimmedRationale,
    timestamp: now(),
    previous_holder: snapshot.holder,
    was_stale: true,
    age_ms: snapshot.age_ms,
    lock_path: lockPath,
    canonical_stale_rationale: STALE_LOCK_RECOVERY,
  };

  // AC21.5: audit-log BEFORE release so the record survives any post-release crash.
  // as-027 / Task I3: stub swapped for real appendAuditEntry call; event_class
  // folded into the 9-class canonical enum as `session_override_flip` with
  // event_subtype `baseline_override_force_release`.
  const auditResult = auditForceReleaseStub(auditPayload);

  releaseBaselineOverrideLock(lockPath);

  console.log(
    JSON.stringify({
      lock: 'baseline-override',
      action: 'force_release',
      result: 'released',
      was_stale: true,
      previous_holder: snapshot.holder,
      age_ms: snapshot.age_ms,
      rationale: trimmedRationale,
      audit: {
        event_class: 'session_override_flip',
        event_subtype: 'baseline_override_force_release',
        appended: auditResult.ok,
        seq: auditResult.seq,
        error: auditResult.error,
        STALE_LOCK_RECOVERY: true,
      },
    }),
  );
  process.exit(0);
}

// =============================================================================
// Main
// =============================================================================

/**
 * as-013 / AC13.1: Per-subcommand --help printer for record-test-writer-unlock.
 *
 * AC13.1 mandates that `node session-checkpoint.mjs record-test-writer-unlock --help`
 * prints the subcommand help text. The CLI dispatcher intercepts `--help`/`-h`
 * as args[1] BEFORE invoking opRecordTestWriterUnlock (which would otherwise
 * treat `--help` as a missing-flag error and raise UNLOCK_USAGE_ERROR).
 *
 * Emits to stdout (Unix convention for explicit --help) and exits 0 via the
 * surrounding case-branch fallthrough to the standard no-throw return path.
 */
function printRecordTestWriterUnlockHelp(toStdout = true) {
  const sink = toStdout ? console.log : console.error;
  sink(`
record-test-writer-unlock — Record bug-fix-mode test-writer unlock

Usage: node session-checkpoint.mjs record-test-writer-unlock <sg-id>
         --dispatch-id <id>
         --first-failure-ref <ref>

Sole-writer CLI for session.active_work.test_writer_unlock[<sg-id>].
TTL: 5 minutes, anchored at first_failure_at. Requires spec_mode='bug-fix'
in the target spec-group manifest (feature-mode rejects with
UNLOCK_MODE_MISMATCH per AC-005.7).

Required arguments:
  <sg-id>                       Positional. Target spec-group id. Must exist
                                under .claude/specs/groups/ with a manifest
                                containing spec_mode='bug-fix'.
  --dispatch-id <id>            Non-empty. Recorded on the unlock entry;
                                cooperative-check later verifies match.
  --first-failure-ref <ref>     Non-empty. Reference to the first failing
                                test run (e.g., test-file:case-name).

Effects on success (exit 0):
  1. Mints HMAC-SHA256 cryptographic marker (per-session ephemeral secret).
  2. Appends {event_class: test_writer_unlock, ...} hash-chained audit entry
     to .claude/audit/pipeline-efficiency-changes.log (BEFORE session write).
  3. Writes session.active_work.test_writer_unlock[<sg-id>] = {
       first_failure_at, unlocked_until, dispatch_id, marker
     }.

Structured errors (non-zero exit):
  UNLOCK_USAGE_ERROR               Missing or empty required arg. Exit 1.
  UNLOCK_MODE_MISMATCH             spec_mode != 'bug-fix'. Exit 1.
  UNLOCK_SESSION_MISSING           No session.json; run 'init' first. Exit 1.
  UNLOCK_SESSION_NO_ACTIVE_WORK    No active_work; run 'start-work'. Exit 1.
  UNLOCK_AUDIT_APPEND_FAILED       Chain append failed. Exit 1.
  GENESIS_ANCHOR_INVALID           Hash-chain genesis anchor corrupt. Exit 2.

References:
  Spec group:   sg-pipeline-efficiency-ws2-practice-2.4
  Atomic specs: as-003 (this CLI), as-004 (marker), as-013 (wiring)
  Requirement:  REQ-005 (AC-005.3, AC-005.7, AC-005.8, AC-005.10)
`);
}

/**
 * as-013 / AC13.1: Per-subcommand --help printer for fire-refence-trigger.
 *
 * Emits to stdout (Unix convention for explicit --help) and exits 0 via the
 * surrounding case-branch fallthrough to the standard no-throw return path.
 * Without this interception, `--help` would be swallowed as a malformed
 * positional and raise REFENCE_USAGE_ERROR.
 */
function printFireRefenceTriggerHelp(toStdout = true) {
  const sink = toStdout ? console.log : console.error;
  sink(`
fire-refence-trigger — Fire an external re-fence trigger; clear unlock[<sg-id>]

Usage: node session-checkpoint.mjs fire-refence-trigger <sg-id>
         --trigger <label>

External-signal entry point for re-fence triggers that do NOT originate from
an internal session-checkpoint op. The predicate clears
session.active_work.test_writer_unlock[<sg-id>] via the sole-writer path and
appends a {event_class: test_writer_unlock_refence, trigger} audit entry.
Idempotent — exits 0 with {cleared: false} when no unlock exists.

Required arguments:
  <sg-id>                       Positional. Target spec-group id.
  --trigger <label>             One of:
                                  version-bump       (spec content_hash change)
                                  workstream-rotate  (facilitator rotation)
                                  spec-complete      (also fires internally)
                                  test-pass          (also fires internally)
                                  session-end        (also fires internally)

Typical external callers:
  version-bump       spec post-edit hooks after spec.md content_hash mutation.
  workstream-rotate  orchestrator facilitator-rotation hook.

The remaining 3 triggers (spec-complete, test-pass, session-end) fire
internally from opTransitionPhase, opUpdateConvergence (unifier gate), and
opCompleteWork / opArchiveIncomplete respectively, so the predicate runs
inside the same session-save transaction as the primary effect.

Structured errors (non-zero exit):
  REFENCE_USAGE_ERROR            Missing or empty required arg. Exit 1.
  REFENCE_TRIGGER_INVALID        --trigger not in canonical enum. Exit 1.
  REFENCE_SESSION_MISSING        No session.json; run 'init' first. Exit 1.

References:
  Spec group:   sg-pipeline-efficiency-ws2-practice-2.4
  Atomic specs: as-005 (predicate), as-013 (wiring)
  Requirement:  REQ-005 (AC-005.6, AC-005.10)
`);
}

/**
 * Per-subcommand --help printer for record-route-decision.
 *
 * Emits to stdout (Unix convention for explicit --help) and exits 0 via the
 * surrounding case-branch fallthrough.
 */
function printRecordRouteDecisionHelp(toStdout = true) {
  const sink = toStdout ? console.log : console.error;
  sink(`
record-route-decision — Append a /route decision to session.active_work.route_decisions[]

Usage: node session-checkpoint.mjs record-route-decision <workflow> <rationale>
         [--risk-tier <tier>] [--multi-domain-justification <json>]

Sole-writer CLI for session.active_work.route_decisions[]. Invoked by the
main-agent after /route produces its decision block, before phase transitions.

Required arguments:
  <workflow>                    Positional. One of:
                                  ${VALID_WORKFLOWS.join(', ')}
  <rationale>                   Positional. First 120 chars of /route's
                                rationale (per OQ-105). Longer strings are
                                truncated. Remaining positional args are
                                joined with spaces.

Optional arguments:
  --risk-tier <tier>             One of: ${VALID_RISK_TIERS.join(', ')}.
                                Stored on active_work for risk-tiered Stop
                                dispatch enforcement.
  --multi-domain-justification <json>
                                JSON array of {criterion, evidence} objects.
                                REQUIRED when workflow=orchestrator (REQ-003);
                                forbidden otherwise. Two or more entries
                                required.
                                Example:
                                  '[{"criterion":"3+ services","evidence":"websocket, auth, db"},
                                    {"criterion":"cross-runtime","evidence":"browser + node"}]'

Effects on success (exit 0):
  1. Appends entry to session.active_work.route_decisions[] (creates array
     on first write). Atomic via atomicModifyJSON + session-lock.
  2. Stores provided risk_tier on active_work.
  3. Adds a route_decision_recorded breadcrumb to session.history.
  4. Best-effort audit entry (event_class=session_checkpoint,
     subtype=record-route-decision). Audit failure does NOT mask the
     successful write; a warning is logged to stderr.

Structured errors (exit 1):
  ROUTE_DECISION_USAGE_ERROR             Missing required arg.
  ROUTE_DECISION_WORKFLOW_INVALID        Unknown workflow value.
  ROUTE_DECISION_RATIONALE_INVALID       Empty rationale.
  ROUTE_DECISION_JUSTIFICATION_REQUIRED  Orchestrator without justification.
  ROUTE_DECISION_JUSTIFICATION_FORBIDDEN Non-orchestrator with justification.
  ROUTE_DECISION_JUSTIFICATION_INVALID   Malformed JSON or contract violation.
  ROUTE_DECISION_RISK_TIER_INVALID       Unknown risk tier.
  ROUTE_DECISION_WRITE_FAILED            Lock or atomic-rename failed.

References:
  Owner doc:    .claude/docs/ROUTING.md
  Contract:     Evidence Requirement — multi_domain_justification
`);
}

function printUsage(toStdout = false) {
  // Module-import API AC-24:
  // Allow callers to route to stdout (Unix convention for explicit --help).
  // Default remains stderr to preserve unknown-operation error stream behavior.
  const sink = toStdout ? console.log : console.error;
  sink(`
Session Checkpoint Utility

Usage: node session-checkpoint.mjs <operation> [args...]

Operations:
  init                                            Initialize session.json
  start-work <spec_group_id> <workflow> <obj>     Start tracking work (positional)
    Optional: --force-reset-convergence            Explicit convergence reset (REQ-001.3)
  start-work --exempt-workflow <workflow>         Start vibe-mode work (flag-only; auto-gen id+objective)
  rotate-worktree <new-root>                       Facilitator-only re-pin of session.active_work.project_dir_pin
                                                   (ws-3 REQ-007 / AC6.3). Canonicalizes <new-root> via
                                                   worktree-canon.capturePin(); appends audit entry
                                                   event_class='worktree_path_violation' subtype='rotate-worktree'.
  reconcile-convergence <spec_group_id>           Run manifest-seed reconciliation on demand (REQ-007.3)
  transition-phase <new_phase>                    Update current phase
  complete-atomic-spec <atomic_spec_id>           Mark atomic spec as done
  dispatch-subagent <id> <type> <desc> [--stage]  Track subagent dispatch
  complete-subagent <task_id> <result_summary>    Mark subagent complete
  clear-async-mode                                Delete shape-lint-async-mode sentinel
  journal-created <path-to-journal>               Mark journal entry as created
  override-skip --phase <p> --rationale "<r>"     Override a phase skip block
  reset-enforcement --rationale "<r>"             Reset all skip counters
  set-enforcement-level <off|warn-only|graduated> Change enforcement level
  override-enforcement <advisory|coercive> --rationale "<r>"
                                                  Session-scoped enforcement flip
                                                  (advisory ↔ coercive). 'off'
                                                  rejected with SESSION_OVERRIDE_OFF_REJECTED
                                                  (REQ-013). Writes session scope
                                                  only; appends audit entry class
                                                  'session_override_flip'.
  complete-work                                   Finalize completed work
  archive-incomplete                              Archive incomplete work
  record-test-writer-unlock <sg-id>               Record bug-fix-mode test-writer unlock
    --dispatch-id <id>                             (sg-pipeline-efficiency-ws2-practice-2.4 / as-003)
    --first-failure-ref <ref>                      Sole-writer for session.json.test_writer_unlock.
                                                   spec_mode must be 'bug-fix'; 5-min TTL anchored at
                                                   first_failure_at. Rejects feature-mode with
                                                   UNLOCK_MODE_MISMATCH (AC-005.7).
  fire-refence-trigger <sg-id>                    Fire re-fence trigger; clears unlock[<sg-id>]
    --trigger <label>                              (sg-pipeline-efficiency-ws2-practice-2.4 / as-005)
                                                   label ∈ {spec-complete, test-pass, version-bump,
                                                   workstream-rotate, session-end}. Idempotent.
                                                   Appends test_writer_unlock_refence audit entry.
  record-route-decision <workflow> <rationale>    Append /route decision to session log
    [--multi-domain-justification <json>]          (ROUTING.md)
                                                   Sole-writer for session.active_work.route_decisions[];
                                                   --multi-domain-justification required when
                                                   workflow=orchestrator (REQ-003). Rationale
                                                   truncated to 120 chars (OQ-105).
  record-pass <gate> --findings-count <N> ...      Record convergence pass evidence
  update-convergence <gate_name>                   Derive convergence count from evidence
  record-deployment --target <t> --method <m>     Record deployment activity
    Flags: --target (required), --method (pipeline|manual), --manual (shorthand)
    Optional: --service <name>                     Look up manifest for env hash
  record-deployment-failure                       Record deployment failure (sets failed=true)
  record-deployment-clear-failure                 Clear deployment.failed after intervention
    Flags: --service <name> (required), --signed-record <path>
  get-status                                      Output session state (JSON)
  verify [--spec-group <sg-id>]                   Run five completion-invariant checks
    Exit 0 on clean, 1 on any failure or resolution error. Read-only.
    Note: distinct from update-convergence's internal post-write verify step.
  inspect-lock <lock-name>                        Inspect an advisory lock (AC21.4-21.5)
    Supported lock names: baseline-override
    Flags:
      --force-release                             Break the lock (audit-logged)
      --rationale "<text>"                        Required with --force-release
    Stale threshold: 15 min (mtime-based). Force-release requires rationale
    and is only permitted on stale locks; use "STALE_LOCK_RECOVERY" as the
    canonical rationale.

Phases:
  ${VALID_PHASES.join(', ')}

Workflows:
  ${VALID_WORKFLOWS.join(', ')}

Subagent Types:
  ${VALID_SUBAGENT_TYPES.join(', ')}

Stages (for --stage flag with dispatch-subagent):
  ${VALID_STAGES.join(', ')}

Enforcement Levels:
  ${VALID_ENFORCEMENT_LEVELS.join(', ')}
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const operation = args[0];

  try {
    switch (operation) {
      case 'init':
        opInit();
        break;

      case 'start-work':
        // sg-enforcement-layer-gaps Task 19: opStartWork now accepts argv
        // tail to support both positional and --exempt-workflow flag-only
        // forms. The function parses flags internally.
        opStartWork(args.slice(1));
        break;

      case 'rotate-worktree':
        // sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-006 / REQ-007 / AC6.3
        // Facilitator-only re-pin action. args[1] is the new canonical root.
        opRotateWorktree(args[1]);
        break;

      case 'transition-phase': {
        // Parse newPhase (positional), optional substage (positional when
        // newPhase === 'challenging'), and optional --workflow flag
        // (WORKFLOW_IMMUTABLE check — sg-workflow-convergence-bugs
        // ws-dag-substages as-004c / AC-C7 / NFR-21).
        //
        // Forms:
        //   transition-phase <new_phase>
        //   transition-phase challenging <substage>
        //   transition-phase <new_phase> --workflow <W>
        //   transition-phase challenging <substage> --workflow <W>
        const tpArgs = args.slice(1);
        let tpNewPhase = null;
        let tpSubstage = null;
        let tpRequestedWorkflow = null;
        const tpPositional = [];
        for (let i = 0; i < tpArgs.length; i++) {
          if (tpArgs[i] === '--workflow' && i + 1 < tpArgs.length) {
            tpRequestedWorkflow = tpArgs[i + 1];
            i++;
          } else {
            tpPositional.push(tpArgs[i]);
          }
        }
        tpNewPhase = tpPositional[0];
        // Only accept a positional substage when newPhase is 'challenging';
        // for other phases, a second positional is silently ignored.
        if (tpNewPhase === 'challenging' && tpPositional.length > 1) {
          tpSubstage = tpPositional[1];
        }
        opTransitionPhase(tpNewPhase, tpSubstage, tpRequestedWorkflow);
        break;
      }

      case 'complete-atomic-spec':
        opCompleteAtomicSpec(args[1]);
        break;

      case 'dispatch-subagent': {
        // Parse --stage and --stage-source flags (as-013 AC-002.4).
        // Suppress unused-variable lint on stageIdx (kept for legacy symmetry).
        const dispatchArgs = args.slice(1);
        let dispatchStage = null;
        let dispatchStageSource = null;
        const filteredArgs = [];

        for (let i = 0; i < dispatchArgs.length; i++) {
          if (dispatchArgs[i] === '--stage' && i + 1 < dispatchArgs.length) {
            dispatchStage = dispatchArgs[i + 1];
            i++;
          } else if (dispatchArgs[i] === '--stage-source' && i + 1 < dispatchArgs.length) {
            dispatchStageSource = dispatchArgs[i + 1];
            i++;
          } else {
            filteredArgs.push(dispatchArgs[i]);
          }
        }

        opDispatchSubagent(
          filteredArgs[0],
          filteredArgs[1],
          filteredArgs.slice(2).join(' '),
          dispatchStage,
          dispatchStageSource,
        );
        break;
      }

      case 'complete-subagent':
        opCompleteSubagent(args[1], args.slice(2).join(' '));
        break;

      case 'clear-async-mode':
        opClearAsyncMode();
        break;

      case 'journal-created':
        opJournalCreated(args[1]);
        break;

      case 'complete-work':
        opCompleteWork();
        break;

      case 'toggle-kill-switch': {
        // Parse <create|remove> + --rationale "<text>" (as-020).
        const tksArgs = args.slice(1);
        const action = tksArgs[0];
        let tksRationale = null;
        for (let i = 1; i < tksArgs.length; i++) {
          if (tksArgs[i] === '--rationale' && i + 1 < tksArgs.length) {
            tksRationale = tksArgs.slice(i + 1).join(' ');
            break;
          }
        }
        opToggleKillSwitch(action, tksRationale);
        break;
      }

      case 'override-enforcement': {
        // sg-pipeline-efficiency-ws1-convergence-pruning / as-019 / REQ-013
        // Parse <advisory|coercive> + --rationale "<text>".
        // 'off' is rejected inside opOverrideEnforcement with
        // SESSION_OVERRIDE_OFF_REJECTED (AC19.3) — CLI does NOT pre-filter
        // so the structured error propagates unambiguously to the caller.
        const oeArgs = args.slice(1);
        const oeMode = oeArgs[0];
        let oeRationale = null;
        for (let i = 1; i < oeArgs.length; i++) {
          if (oeArgs[i] === '--rationale' && i + 1 < oeArgs.length) {
            oeRationale = oeArgs.slice(i + 1).join(' ');
            break;
          }
        }
        opOverrideEnforcement(oeMode, oeRationale);
        break;
      }

      case 'archive-incomplete':
        opArchiveIncomplete();
        break;

      case 'record-test-writer-unlock': {
        // sg-pipeline-efficiency-ws2-practice-2.4 / as-003 / as-013 / REQ-005
        // Usage:
        //   record-test-writer-unlock <sg-id> --dispatch-id <id> --first-failure-ref <ref>
        //   record-test-writer-unlock --help
        //
        // Sole-writer CLI for session.json.test_writer_unlock[<sg-id>].
        // Preflight enforces spec_mode='bug-fix' (UNLOCK_MODE_MISMATCH
        // otherwise — AC-005.7). TTL is 5 min anchored at first_failure_at.
        //
        // as-013 / AC13.1: intercept --help/-h as args[1] BEFORE the op
        // handler so `record-test-writer-unlock --help` prints subcommand
        // help to stdout and exits 0 instead of raising UNLOCK_USAGE_ERROR.
        if (args[1] === '--help' || args[1] === '-h') {
          printRecordTestWriterUnlockHelp(true);
          break;
        }
        const rwuArgs = args.slice(1);
        let rwuSpecGroupId = null;
        let rwuDispatchId = null;
        let rwuFirstFailureRef = null;
        for (let i = 0; i < rwuArgs.length; i++) {
          if (rwuArgs[i] === '--dispatch-id' && i + 1 < rwuArgs.length) {
            rwuDispatchId = rwuArgs[i + 1];
            i++;
          } else if (rwuArgs[i] === '--first-failure-ref' && i + 1 < rwuArgs.length) {
            rwuFirstFailureRef = rwuArgs[i + 1];
            i++;
          } else if (rwuSpecGroupId === null && !rwuArgs[i].startsWith('--')) {
            rwuSpecGroupId = rwuArgs[i];
          }
        }
        opRecordTestWriterUnlock(rwuSpecGroupId, rwuDispatchId, rwuFirstFailureRef);
        break;
      }

      case 'record-route-decision': {
        // Routing decision persistence.
        // Usage:
        //   record-route-decision <workflow> <rationale>
        //     [--risk-tier <tier>] [--multi-domain-justification <json>]
        //   record-route-decision --help
        //
        // Sole-writer CLI for session.active_work.route_decisions[]. The
        // main-agent invokes this after /route produces its decision block,
        // before phase transitions. Justification is required for
        // workflow=orchestrator (REQ-003) and forbidden otherwise.
        if (args[1] === '--help' || args[1] === '-h') {
          printRecordRouteDecisionHelp(true);
          break;
        }
        const rrdArgs = args.slice(1);
        let rrdWorkflow = null;
        let rrdJustification = null;
        let rrdRiskTier = null;
        const rrdPositional = [];
        for (let i = 0; i < rrdArgs.length; i++) {
          if (rrdArgs[i] === '--multi-domain-justification' && i + 1 < rrdArgs.length) {
            rrdJustification = rrdArgs[i + 1];
            i++;
          } else if (rrdArgs[i] === '--risk-tier' && i + 1 < rrdArgs.length) {
            rrdRiskTier = rrdArgs[i + 1];
            i++;
          } else {
            rrdPositional.push(rrdArgs[i]);
          }
        }
        rrdWorkflow = rrdPositional[0];
        // Rationale can contain spaces — join the remaining positional args.
        const rrdRationale = rrdPositional.slice(1).join(' ');
        opRecordRouteDecision(rrdWorkflow, rrdRationale, rrdJustification, rrdRiskTier);
        break;
      }

      case 'fire-refence-trigger': {
        // sg-pipeline-efficiency-ws2-practice-2.4 / as-005 / as-013 / REQ-005 / AC-005.6
        // Usage:
        //   fire-refence-trigger <sg-id> --trigger <label>
        //   fire-refence-trigger --help
        //
        // External-signal entry point for version-bump + workstream-rotate
        // triggers (the other 3 fire from internal op* code paths). Clears
        // session.active_work.test_writer_unlock[<sg-id>] via the sole-writer
        // path and appends a `test_writer_unlock_refence` audit entry with
        // the `trigger` label. Idempotent no-op if no unlock exists.
        //
        // as-013 / AC13.1: intercept --help/-h as args[1] BEFORE the op
        // handler so `fire-refence-trigger --help` prints subcommand help
        // to stdout and exits 0 instead of raising REFENCE_USAGE_ERROR.
        if (args[1] === '--help' || args[1] === '-h') {
          printFireRefenceTriggerHelp(true);
          break;
        }
        const frtArgs = args.slice(1);
        let frtSpecGroupId = null;
        let frtTrigger = null;
        for (let i = 0; i < frtArgs.length; i++) {
          if (frtArgs[i] === '--trigger' && i + 1 < frtArgs.length) {
            frtTrigger = frtArgs[i + 1];
            i++;
          } else if (frtSpecGroupId === null && !frtArgs[i].startsWith('--')) {
            frtSpecGroupId = frtArgs[i];
          }
        }
        opFireRefenceTrigger(frtSpecGroupId, frtTrigger);
        break;
      }

      case 'override-skip': {
        // Parse --phase and --rationale flags
        const osArgs = args.slice(1);
        let osPhase = null;
        let osRationale = null;

        for (let i = 0; i < osArgs.length; i++) {
          if (osArgs[i] === '--phase' && i + 1 < osArgs.length) {
            osPhase = osArgs[i + 1];
            i++;
          } else if (osArgs[i] === '--rationale' && i + 1 < osArgs.length) {
            osRationale = osArgs.slice(i + 1).join(' ');
            break;
          }
        }

        opOverrideSkip(osPhase, osRationale);
        break;
      }

      case 'reset-enforcement': {
        // Parse --rationale flag
        const reArgs = args.slice(1);
        let reRationale = null;

        for (let i = 0; i < reArgs.length; i++) {
          if (reArgs[i] === '--rationale' && i + 1 < reArgs.length) {
            reRationale = reArgs.slice(i + 1).join(' ');
            break;
          }
        }

        opResetEnforcement(reRationale);
        break;
      }

      case 'set-enforcement-level':
        opSetEnforcementLevel(args[1]);
        break;

      case 'record-pass':
        opRecordPass(args.slice(1));
        break;

      case 'update-convergence':
        opUpdateConvergence(args[1], args[2]);
        break;

      case 'update-circuit-breaker':
        // Convergence circuit-breaker AC-14
        opUpdateCircuitBreaker(args.slice(1));
        break;

      case 'get-status':
        opGetStatus();
        break;

      case 'record-deployment': {
        await opRecordDeployment(args.slice(1));
        break;
      }

      case 'record-deployment-failure':
        opRecordDeploymentFailure();
        break;

      case 'record-deployment-clear-failure': {
        await opRecordDeploymentClearFailure(args.slice(1));
        break;
      }

      case 'verify':
        opVerify(args.slice(1));
        break;

      case 'inspect-lock': {
        // sg-pipeline-efficiency-ws1-convergence-pruning / as-021 / REQ-011 / AC21.4-21.5:
        //   inspect-lock baseline-override [--force-release --rationale "<r>"]
        const ilArgs = args.slice(1);
        const lockName = ilArgs[0];
        let forceRelease = false;
        let ilRationale = null;
        for (let i = 1; i < ilArgs.length; i++) {
          if (ilArgs[i] === '--force-release') {
            forceRelease = true;
          } else if (ilArgs[i] === '--rationale' && i + 1 < ilArgs.length) {
            ilRationale = ilArgs.slice(i + 1).join(' ');
            break;
          }
        }
        opInspectLock({ lockName, forceRelease, rationale: ilRationale });
        break;
      }

      case 'reconcile-convergence':
        // Shared entry point so completion-verifier can invoke the same
        // reconciliation helper used by start-work. On-demand only; no
        // history entry unless a seed event actually fires.
        opReconcileConvergence(args.slice(1));
        break;

      case '--help':
      case '-h':
      case 'help':
        // Explicit help request -> stdout (Unix convention)
        printUsage(true);
        break;

      default:
        console.error(`Unknown operation: ${operation}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    // as-007 AC7.3: GENESIS_ANCHOR_INVALID exits 2 (fail-closed; operator must
    // resolve the hash-chain genesis anchor before retrying). All other
    // TestWriterUnlockError codes + generic errors exit 1.
    console.error(`Error: ${err.message}`);
    if (err && err.name === 'TestWriterUnlockError' && err.code === 'GENESIS_ANCHOR_INVALID') {
      process.exit(2);
    }
    process.exit(1);
  }
}

// Module-import API AC-24:
// Dual-mode guard. Run CLI dispatch only when this file is the entry point.
// When imported as a module (e.g., from convergence-pass-recorder.mjs), the
// import must NOT trigger argv parsing, dispatch, process.exit, or stdio output.
//
// Use pathToFileURL to handle symlink-resolved paths and special characters
// correctly. Naive `file://${process.argv[1]}` concatenation can fail when
// argv[1] is a symlinked path (e.g., /tmp -> /private/tmp on macOS) because
// import.meta.url is realpath-resolved while argv[1] is not.
const __isCliEntry = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (__isCliEntry) {
  main().catch((err) => {
    // as-007 AC7.3: preserve exit-2 semantics for GENESIS_ANCHOR_INVALID on
    // promise-rejection paths (mirrors the in-main try/catch mapping).
    console.error(`Error: ${err.message}`);
    if (err && err.name === 'TestWriterUnlockError' && err.code === 'GENESIS_ANCHOR_INVALID') {
      process.exit(2);
    }
    process.exit(1);
  });
}
