#!/usr/bin/env node

/**
 * SubagentStop Dispatch Record Hook (Task 23 / Task 32 — sg-enforcement-layer-gaps)
 *
 * Per Task 22 feasibility outcome (FALLBACK_PATH_SUBAGENTSTOP activated),
 * this hook fires on SubagentStop (not PostToolUse+Agent — that combo is not
 * supported by Claude Code's hook surface). It records the Task-tool dispatch
 * in `session.json` via the sole-writer `session-checkpoint.mjs` CLI, updating
 * an existing PreToolUse-recorded entry from `in_flight` → `completed`, or
 * creating a new entry if none was recorded at dispatch time (EC-7 fail-open).
 *
 * Payload shape (Claude Code SubagentStop envelope):
 *   {
 *     hook_event_name: "SubagentStop",
 *     stop_hook_active: boolean,
 *     session_id: string,
 *     agent_type: string,           // e.g., "implementer"
 *     agent_id: string,             // unique subagent instance ID
 *     agent_transcript_path: string,// path to the subagent's transcript
 *     last_assistant_message: string,
 *     ...
 *   }
 *
 * Wire contract (AC-9.1 through AC-9.10, AC-11.4 through AC-11.8):
 *   - Invokes `session-checkpoint.mjs complete-subagent <id> <summary>` when
 *     an entry for `agent_id` already exists in-flight (PreToolUse recorded it).
 *   - If no in-flight entry exists, invokes `dispatch-subagent <id> <type> <desc>`
 *     to create one with status `completed` — this handles both (a) PreToolUse
 *     fail-open cases and (b) sessions where PreToolUse was not configured.
 *   - Sole-writer invariant: NEVER writes session.json directly. All mutations
 *     route through the CLI.
 *   - Last-write-wins: duplicate dispatch_id handling is implemented inside
 *     session-checkpoint.mjs opDispatchSubagent (AC-9.7, AC-9.10) and
 *     opCompleteSubagent (idempotent completion).
 *   - Type-mismatch rejection: implemented inside session-checkpoint.mjs
 *     (AC-11.4–11.8). This hook forwards the `agent_type` verbatim; the CLI
 *     compares against any prior in-flight record and rejects with generic
 *     message on mismatch.
 *
 * Fail-open semantics (EC-7):
 *   - Any structural error (missing session.json, malformed payload, CLI crash)
 *     emits a warning to stderr and exits 0. Never blocks subagent completion.
 *   - Missing `agent_type` or `agent_id` → exit 0 with warning (payload malformed).
 *
 * Exit codes:
 *   0 - Always (cooperative writer; fail-open on any error)
 *
 * Spec: sg-enforcement-layer-gaps — Task 23, Task 25, Task 32.
 * Registered in .claude/settings.json under SubagentStop.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getCanonicalProjectDir,
  CanonicalProjectDirError,
} from './lib/hook-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);

// =============================================================================
// Constants
// =============================================================================

const HOOK_ID = 'dispatch-record-hook';

// Generic rejection message per AC-11.8 (no type-hint leakage).
const GENERIC_REJECT_MESSAGE = 'record rejected';

// cr-const-b1c2d3: Hard cap on session-checkpoint CLI subprocess execution.
// 10 seconds is enough headroom for lock-contended writes (session-lock.mjs
// retries up to ~5s) plus a margin for JSON parse + single-file atomic write.
// Exceeding this means the CLI is wedged; SubagentStop is fail-open so we
// warn and exit 0 rather than hanging the subagent lifecycle.
const CHECKPOINT_CLI_TIMEOUT_MS = 10_000;

// sec-envleak-d8e31204: Minimum environment-variable allowlist for the
// session-checkpoint CLI subprocess. Only the vars the CLI actually reads
// are forwarded; everything else (AWS creds, SSH agents, shell history,
// user secrets piped into the parent process, etc.) stays inside this
// hook's own process.
//   CLAUDE_PROJECT_DIR — required for claudeDir discovery (hook-utils,
//     yaml-utils, trace-utils all consult this).
//   PATH — required for Node's own child_process / OS lookups.
//   HOME — needed by Node for `~`-style cache + config paths on some hosts.
//   USER — session-checkpoint.mjs records operator in audit entries
//     (`operator: process.env.USER || 'unknown'`), so dropping it would
//     silently swap every SubagentStop-path audit to "unknown".
//   CLAUDE_USER_PROMPT — consumed by session-checkpoint for start-work
//     annotation; harmless if missing but preserved for behavioral parity.
const CHECKPOINT_CLI_ENV_ALLOWLIST = [
  'CLAUDE_PROJECT_DIR',
  'PATH',
  'HOME',
  'USER',
  'CLAUDE_USER_PROMPT',
];

// chk-boundary-d7e8f102: AC-11.4 declares PreToolUse the authoritative source
// for subagent_type (SEC-004). SubagentStop payloads are agent-controlled and
// MUST NOT be treated as authoritative when no prior PreToolUse record exists.
// Use this sentinel in the no-prior-record fallback so downstream consumers
// can distinguish trusted records from untrusted payload-derived ones.
const UNTRUSTED_AGENT_TYPE_SENTINEL = 'unknown_fallback';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Read all bytes from stdin. Returns '' on empty / missing input.
 */
async function readStdinBytes() {
  const chunks = [];
  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
  } catch {
    return '';
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Resolve the .claude/ directory.
 *
 * as-012 (REQ-003.6): delegates to `getCanonicalProjectDir()` so symlink
 * traversal is rejected uniformly. Falls back to an ancestor walk from the
 * script's own location only when the canonicalizer cannot resolve the env
 * (legacy / non-hook invocation).
 */
function findClaudeDir() {
  try {
    return join(getCanonicalProjectDir(), '.claude');
  } catch (err) {
    if (!(err instanceof CanonicalProjectDirError)) throw err;
    // Fallback: walk up from script location
    let current = SCRIPT_DIR;
    while (current !== sep && current.length > 1) {
      const candidate = current.endsWith(`${sep}.claude`) ? current : join(current, '.claude');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return join(process.cwd(), '.claude');
  }
}

/**
 * Load the session JSON. Returns null on any error.
 */
function loadSessionSafe(claudeDir) {
  const path = join(claudeDir, 'context', 'session.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Find an in-flight dispatch record by task_id or agent_id.
 * Falls back to completed_this_session to detect replayed SubagentStop.
 */
function findExistingDispatch(session, taskId) {
  if (!session?.subagent_tasks) return null;
  const inFlight = session.subagent_tasks.in_flight || [];
  const completed = session.subagent_tasks.completed_this_session || [];
  return (
    inFlight.find((t) => t.task_id === taskId) ||
    completed.find((t) => t.task_id === taskId) ||
    null
  );
}

/**
 * Warn to stderr with hook prefix. Always non-blocking.
 */
function warn(message) {
  process.stderr.write(`[${HOOK_ID}] ${message}\n`);
}

/**
 * Invoke session-checkpoint.mjs as a subprocess (sole-writer invariant).
 * Returns { status, stdout, stderr }. Never throws.
 */
function invokeCheckpoint(claudeDir, args, env = {}) {
  const scriptPath = join(dirname(claudeDir), '.claude', 'scripts', 'session-checkpoint.mjs');
  // CLAUDE_DIR is the path to .claude; the script path is that + /scripts/session-checkpoint.mjs
  const actualScriptPath = join(claudeDir, 'scripts', 'session-checkpoint.mjs');
  if (!existsSync(actualScriptPath)) {
    return { status: -1, stdout: '', stderr: `session-checkpoint.mjs not found at ${actualScriptPath}` };
  }
  // sec-envleak-d8e31204: build a minimal env allowlist rather than passing
  // all of process.env through to the CLI. See CHECKPOINT_CLI_ENV_ALLOWLIST
  // comment above for what's included and why.
  const childEnv = {};
  for (const key of CHECKPOINT_CLI_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      childEnv[key] = process.env[key];
    }
  }
  // Caller-supplied env overrides come next (test harnesses, explicit
  // CLAUDE_PROJECT_DIR bumps), and CLAUDE_PROJECT_DIR is then pinned to
  // the resolved claudeDir so the CLI agrees on project root.
  Object.assign(childEnv, env, { CLAUDE_PROJECT_DIR: dirname(claudeDir) });
  const result = spawnSync('node', [actualScriptPath, ...args], {
    env: childEnv,
    encoding: 'utf-8',
    timeout: CHECKPOINT_CLI_TIMEOUT_MS,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  let payloadRaw = '';
  try {
    payloadRaw = await readStdinBytes();
  } catch {
    // stdin unreadable; fail-open
    process.exit(0);
  }

  if (!payloadRaw.trim()) {
    // No stdin: fail-open (payload missing)
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    warn('payload malformed JSON — skipping');
    process.exit(0);
  }

  // Extract authoritative fields. AC-11.4: subagent_type is derived from the
  // tool-invocation payload. For SubagentStop, `agent_type` is the documented
  // field (convergence-pass-recorder.mjs:47-51 uses the same extraction).
  const agentType = payload.agent_type || payload.subagent_type;
  const agentId = payload.agent_id;
  const sessionId = payload.session_id;
  const lastMessage = payload.last_assistant_message || '';
  const payloadWorkId =
    typeof payload.work_id === 'string'
      ? payload.work_id.trim()
      : (typeof payload.workId === 'string' ? payload.workId.trim() : '');

  // AC-9.5 implicit: if payload lacks required fields, exit without writing.
  if (!agentType || !agentId) {
    warn('payload missing agent_type or agent_id — nothing to record');
    process.exit(0);
  }

  const claudeDir = findClaudeDir();
  const session = loadSessionSafe(claudeDir);

  if (!session) {
    // No session: fail-open (EC-7). Don't try to create one from SubagentStop —
    // that would bypass the start-work trust channel.
    warn('session.json missing or unreadable — skipping dispatch record');
    process.exit(0);
  }

  // Defense-in-depth: if enforcement_compromised is already set, do not record
  // further dispatches (SEC-015). The session-checkpoint CLI will reject anyway,
  // but short-circuiting here avoids noisy stderr.
  if (session.enforcement_compromised === true) {
    warn('enforcement_compromised — skipping dispatch record');
    process.exit(0);
  }

  // task_id is the subagent's agent_id from the SubagentStop payload.
  const taskId = agentId;

  const existing = findExistingDispatch(session, taskId);

  if (existing) {
    // A PreToolUse Agent dispatch or an earlier direct invocation already
    // recorded this task. Mark it complete via the CLI. Completion is
    // idempotent: opCompleteSubagent short-circuits on already-completed.
    //
    // AC-11.4 / AC-11.5: type mismatch between payload and prior record is
    // detected by opDispatchSubagent; for completion we don't re-assert type
    // to avoid double-counting mismatches. The PreToolUse-side contract is
    // authoritative.
    const summary = lastMessage
      ? lastMessage.slice(0, 500).replace(/\n+/g, ' ')
      : 'SubagentStop fired without assistant message';
    const result = invokeCheckpoint(claudeDir, ['complete-subagent', taskId, summary]);
    if (result.status !== 0) {
      warn(
        `complete-subagent exit ${result.status}: ${result.stderr.slice(0, 500)}`
      );
    }
    process.exit(0);
  }

  // No prior record. EC-7 / AC-9.6 guidance: record a fresh dispatch so Stop
  // hook satisfaction is preserved.
  //
  // chk-boundary-d7e8f102 trust-boundary fix: AC-11.4 declares PreToolUse the
  // AUTHORITATIVE source for subagent_type (SEC-004). Without a prior
  // PreToolUse record, the agent-controlled SubagentStop payload is NOT
  // authoritative — treating it as such would allow a subagent to forge its
  // own type. Record the dispatch with the sentinel type so the audit trail
  // preserves the fact that the type is untrusted; a separate operator review
  // can reclassify if needed. The agent-reported type is preserved in the
  // description for forensic review only.
  const reportedType = String(agentType);
  const desc = (
    payload.description || `SubagentStop:${reportedType} [reported,untrusted]`
  )
    .toString()
    .slice(0, 200);
  warn(
    `untrusted-fallback: no PreToolUse record for task_id=${taskId}; ` +
      `recording with agent_type="${UNTRUSTED_AGENT_TYPE_SENTINEL}" (reported: "${reportedType}")`
  );
  const dispatchResult = invokeCheckpoint(claudeDir, [
    'dispatch-subagent',
    taskId,
    UNTRUSTED_AGENT_TYPE_SENTINEL,
    desc,
    ...(payloadWorkId ? ['--work-id', payloadWorkId] : []),
  ]);

  if (dispatchResult.status !== 0) {
    // Common: type-mismatch rejection (AC-11.5) or validation failure.
    // Emit generic message — no type-hint leakage (AC-11.8).
    if (/type mismatch/i.test(dispatchResult.stderr)) {
      warn(GENERIC_REJECT_MESSAGE);
    } else if (dispatchResult.stderr) {
      warn(`dispatch-subagent exit ${dispatchResult.status}: ${dispatchResult.stderr.slice(0, 500)}`);
    }
    process.exit(0); // fail-open
  }

  // After creating the record, mark it complete so stop-hook satisfaction
  // reflects the post-completion state (AC-9.6).
  const summary = lastMessage
    ? lastMessage.slice(0, 500).replace(/\n+/g, ' ')
    : 'SubagentStop fired without assistant message';
  const completeResult = invokeCheckpoint(claudeDir, ['complete-subagent', taskId, summary]);
  if (completeResult.status !== 0) {
    warn(
      `complete-subagent (post-create) exit ${completeResult.status}: ${completeResult.stderr.slice(0, 500)}`
    );
  }

  process.exit(0);
}

// Guard: only run main when invoked directly (not when imported for testing).
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isDirectRun) {
  main().catch((err) => {
    // Final safety net: any uncaught error exits 0 with warning.
    warn(`uncaught error: ${err.message}`);
    process.exit(0);
  });
}

// Exports for unit testing
export {
  findExistingDispatch,
  invokeCheckpoint,
  findClaudeDir,
  GENERIC_REJECT_MESSAGE,
  UNTRUSTED_AGENT_TYPE_SENTINEL,
};
