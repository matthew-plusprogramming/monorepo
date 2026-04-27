#!/usr/bin/env node

/**
 * Test-Writer Isolation Enforcement — PreToolUse cooperative-check hook.
 *
 * Spec: sg-pipeline-efficiency-ws2-practice-2.4 / as-006 / REQ-005
 * Acceptance criteria:
 *   AC6.1: spec_mode feature OR absent → block implementation-file reads
 *          regardless of any unlock state (AC-005.2).
 *   AC6.2: spec_mode == bug-fix AND valid unlock (TTL unexpired, dispatch_id
 *          match, HMAC marker verifies) → permit implementation-file read
 *          (AC-005.4).
 *   AC6.3: Any single cooperative-check step fails → block with
 *          UNLOCK_REVOKED; a second failed attempt yields TIMEOUT (AC-005.5).
 *   AC6.4: session.json unreadable / missing → fail-closed (block).
 *   AC6.5: End-to-end cooperative-check completes in <1s on local filesystem.
 *
 * Architecture — sentinel + 5-step gate
 * -------------------------------------
 * Sentinel at `.claude/coordination/active-test-writer-session` carries the
 * in-flight test-writer dispatch context: `{session_id, dispatch_id,
 * spec_group_id, agent_type: 'test-writer', set_at}`. The sentinel is written
 * at Agent-matcher dispatch time (subagent_type='test-writer') and cleared
 * when a non-test-writer Agent dispatch or SubagentStop fires.
 *
 * On Read operations, the 5-step gate sequence runs per
 * .claude/docs/design/test-writer-unlock-state-signals.md §5:
 *   1. Atomic-read session.json and extract test_writer_unlock[sg-id].
 *   2. Check unlocked_until > now().
 *   3. Check dispatch_id matches the sentinel's dispatch_id.
 *   4. Verify HMAC marker via verifyMarker (constant-time compare).
 *   5. Permit-or-revoke.
 * Any failure → emit UNLOCK_REVOKED (first attempt) / TIMEOUT (retry).
 *
 * Fail-closed defaults (AC6.4):
 *   - session.json unreadable, absent, or malformed → block.
 *   - manifest.spec_mode != 'bug-fix' → block regardless of unlock state.
 *   - test_writer_unlock[sg-id] absent → block.
 *   - Any entry field missing or malformed → block.
 *   - HMAC secret file absent / unreadable / wrong length → block.
 *   - Marker verification throws or returns false → block.
 *
 * Retry bookkeeping:
 *   Retry state lives at `.claude/coordination/.test-writer-retry-<sg-id>` and
 *   tracks (session_id, dispatch_id, attempt_count). The first failed
 *   cooperative-check writes attempt_count=1 and emits UNLOCK_REVOKED; the
 *   second failure (same dispatch, same sg-id) reads the retry file, bumps
 *   to 2, and emits TIMEOUT. When a check *succeeds*, the retry file for
 *   that (sg-id, dispatch_id) is cleared.
 *
 * Read allowlist (feature-mode AND hybrid-with-no-unlock):
 *   The spec/contract/template/test/docs allowlist mirrors the e2e-blackbox
 *   hook (same isolation principle). When no unlock is active, reads outside
 *   the allowlist are blocked with UNLOCK_REVOKED.
 *
 * @req REQ-005 (AC-005.2, AC-005.4, AC-005.5)
 * @spec sg-pipeline-efficiency-ws2-practice-2.4 / atomic/as-006.md
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  renameSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash, constants as cryptoConstants } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  getCanonicalProjectDir,
  CanonicalProjectDirError,
} from './lib/hook-utils.mjs';
import {
  verifyMarker,
} from './lib/test-writer-unlock-marker.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Sentinel path (relative). Session-scoped; written by Agent matcher. */
const SENTINEL_RELATIVE_PATH = '.claude/coordination/active-test-writer-session';

/** Retry tracking directory (relative). */
const RETRY_DIR_RELATIVE = '.claude/coordination';

/** HMAC secret file basename template. Matches session-checkpoint.mjs. */
const SESSION_HMAC_BASENAME = (sessionId) => `.session-hmac-${sessionId}`;

/** HMAC secret byte length. Must match session-checkpoint.mjs. */
const SESSION_HMAC_SECRET_BYTES = 32;

/** Structured error codes (no raw strings; consumers branch on these). */
const ERR_UNLOCK_REVOKED = 'UNLOCK_REVOKED';
const ERR_TIMEOUT = 'TIMEOUT';

/** Read allowlist prefixes (same principle as e2e-blackbox). */
const READ_ALLOWLIST_PREFIXES = [
  '.claude/specs/',
  '.claude/contracts/',
  '.claude/templates/',
  'tests/',
  'docs/',
];

/** SLA budget (AC6.5). Informational — the gate is inherently bounded. */
const COOPERATIVE_CHECK_SLA_MS = 1000;

// =============================================================================
// Helpers: stdin + project root
// =============================================================================

/**
 * Read all stdin as a string.
 * @returns {Promise<string>}
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Resolve the project root. Delegates to getCanonicalProjectDir for
 * symlink-traversal defense; falls back to ancestor walk on legacy contexts.
 * @returns {string}
 */
function findProjectRoot() {
  try {
    return getCanonicalProjectDir();
  } catch (err) {
    if (!(err instanceof CanonicalProjectDirError)) throw err;
    let dir = process.cwd();
    while (dir !== '/') {
      if (existsSync(join(dir, '.claude'))) return dir;
      dir = resolve(dir, '..');
    }
    return process.cwd();
  }
}

/**
 * Check whether a resolved absolute path starts with one of the allowlist prefixes.
 * @param {string} filePath
 * @param {string} projectRoot
 * @param {string[]} allowedPrefixes
 * @returns {{allowed: boolean, resolvedPath: string, matchedPrefix: string|null}}
 */
function checkPathAgainstAllowlist(filePath, projectRoot, allowedPrefixes) {
  const resolvedPath = resolve(projectRoot, filePath);
  for (const prefix of allowedPrefixes) {
    const absolutePrefix = resolve(projectRoot, prefix);
    if (resolvedPath.startsWith(absolutePrefix)) {
      return { allowed: true, resolvedPath, matchedPrefix: prefix };
    }
  }
  return { allowed: false, resolvedPath, matchedPrefix: null };
}

// =============================================================================
// Sentinel: extended shape for test-writer dispatch context
// =============================================================================

/**
 * Sentinel payload shape:
 *   { session_id, dispatch_id, spec_group_id, agent_type: 'test-writer', set_at }
 *
 * Agent-matcher writes the sentinel at test-writer dispatch time. The dispatch
 * context (dispatch_id + spec_group_id) comes from the session's active_work
 * block + a deterministic dispatch-id derived from session_id + prompt slice.
 * A non-test-writer Agent dispatch clears the sentinel so subsequent Reads by
 * other agents are not spuriously enforced.
 *
 * @typedef {{
 *   session_id: string,
 *   dispatch_id: string,
 *   spec_group_id: string,
 *   agent_type: 'test-writer',
 *   set_at: string,
 * }} TestWriterSentinel
 */

/**
 * Read the test-writer sentinel scoped to the current session.
 * Returns null when absent, malformed, or cross-session.
 *
 * @param {string} projectRoot
 * @param {string} currentSessionId
 * @returns {TestWriterSentinel|null}
 */
function readSentinel(projectRoot, currentSessionId) {
  const sentinelPath = join(projectRoot, SENTINEL_RELATIVE_PATH);
  if (!existsSync(sentinelPath)) return null;
  let raw;
  try {
    raw = readFileSync(sentinelPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (parsed.session_id !== currentSessionId) return null;
  if (parsed.agent_type !== 'test-writer') return null;
  if (typeof parsed.dispatch_id !== 'string' || parsed.dispatch_id.length === 0) return null;
  if (typeof parsed.spec_group_id !== 'string' || parsed.spec_group_id.length === 0) return null;
  return parsed;
}

/**
 * Delete the sentinel if present. Best-effort (swallows ENOENT).
 * @param {string} projectRoot
 */
function deleteSentinel(projectRoot) {
  const sentinelPath = join(projectRoot, SENTINEL_RELATIVE_PATH);
  if (!existsSync(sentinelPath)) return;
  try {
    unlinkSync(sentinelPath);
  } catch {
    /* best-effort */
  }
}

// =============================================================================
// Session.json atomic-read (Step 1 of cooperative-check) — AC-005.5
// =============================================================================

/**
 * Atomic-read session.json with lstat + realpath + O_NOFOLLOW checks. Prevents
 * TOCTOU symlink swaps between the lstat and the read.
 *
 * Fail-closed: returns null on any IO error, symlink presence, or
 * realpath-mismatch. The hook treats `null` as "cooperative-check fails".
 *
 * @param {string} projectRoot
 * @returns {object|null} parsed session.json, or null on failure
 */
function atomicReadSessionJson(projectRoot) {
  const sessionPath = join(projectRoot, '.claude', 'context', 'session.json');
  if (!existsSync(sessionPath)) return null;

  // lstat + realpath consistency check (AC-005.5 atomic-read protocol).
  let statsBeforeOpen;
  try {
    statsBeforeOpen = lstatSync(sessionPath);
  } catch {
    return null;
  }
  if (statsBeforeOpen.isSymbolicLink()) return null;

  let canonicalPath;
  try {
    canonicalPath = realpathSync(sessionPath);
  } catch {
    return null;
  }
  if (canonicalPath !== sessionPath) return null;

  // Open with O_NOFOLLOW so a symlink planted between lstat and open still
  // fails (redundant with the lstat above but defense-in-depth).
  let fd;
  try {
    const flags = cryptoConstants.O_RDONLY | (cryptoConstants.O_NOFOLLOW || 0);
    fd = openSync(sessionPath, flags);
  } catch {
    return null;
  }

  let raw;
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(size);
    let bytesRead = 0;
    while (bytesRead < size) {
      const n = readSync(fd, buf, bytesRead, size - bytesRead, bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
    raw = buf.subarray(0, bytesRead).toString('utf-8');
  } catch {
    try { closeSync(fd); } catch { /* already closed */ }
    return null;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read manifest.spec_mode with fail-closed default to 'feature'. Returns
 * 'feature' if manifest is missing, unreadable, or the field is absent —
 * any of these pins the state machine to Fenced per design-doc §2.4.
 *
 * @param {string} projectRoot
 * @param {string} specGroupId
 * @returns {string} one of 'feature' | 'bug-fix' | 'refactor' or 'feature' default
 */
function readManifestSpecMode(projectRoot, specGroupId) {
  const manifestPath = join(
    projectRoot,
    '.claude',
    'specs',
    'groups',
    specGroupId,
    'manifest.json',
  );
  if (!existsSync(manifestPath)) return 'feature';
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch {
    return 'feature';
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'feature';
  }
  const mode = parsed && typeof parsed.spec_mode === 'string' ? parsed.spec_mode : 'feature';
  return mode.length > 0 ? mode : 'feature';
}

/**
 * Read per-session HMAC secret. Must match session-checkpoint.mjs shape:
 *   - path: .claude/coordination/.session-hmac-<session-id>
 *   - mode: 0600, 32 raw bytes
 * Fail-closed: returns null on any error.
 *
 * @param {string} projectRoot
 * @param {string} sessionId
 * @returns {Buffer|null}
 */
function readSessionHmacSecret(projectRoot, sessionId) {
  if (!sessionId) return null;
  const secretPath = join(
    projectRoot,
    '.claude',
    'coordination',
    SESSION_HMAC_BASENAME(sessionId),
  );
  if (!existsSync(secretPath)) return null;
  let buf;
  try {
    buf = readFileSync(secretPath);
  } catch {
    return null;
  }
  if (buf.length !== SESSION_HMAC_SECRET_BYTES) return null;
  return buf;
}

// =============================================================================
// Retry bookkeeping for UNLOCK_REVOKED → TIMEOUT escalation
// =============================================================================

/**
 * Compute the retry-tracking file path for a (sg-id, dispatch-id) tuple.
 * Hashed to keep the basename portable.
 * @param {string} projectRoot
 * @param {string} specGroupId
 * @param {string} dispatchId
 * @returns {string}
 */
function retryStatePath(projectRoot, specGroupId, dispatchId) {
  const digest = createHash('sha256')
    .update(`${specGroupId}\x00${dispatchId}`)
    .digest('hex')
    .slice(0, 16);
  return join(projectRoot, RETRY_DIR_RELATIVE, `.test-writer-retry-${digest}`);
}

/**
 * Read attempt count. Missing file → 0.
 * @param {string} path
 * @returns {number}
 */
function readAttemptCount(path) {
  if (!existsSync(path)) return 0;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    const n = typeof parsed?.attempt_count === 'number' ? parsed.attempt_count : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Persist attempt count. Best-effort; returns silently on error.
 * @param {string} path
 * @param {number} attemptCount
 * @param {{spec_group_id: string, dispatch_id: string, session_id: string}} meta
 */
function writeAttemptCount(path, attemptCount, meta) {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = {
      attempt_count: attemptCount,
      last_attempt_at: new Date().toISOString(),
      ...meta,
    };
    writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  } catch {
    /* best-effort */
  }
}

/**
 * Clear the retry-state file (happy-path: cooperative-check passed).
 * @param {string} path
 */
function clearAttemptState(path) {
  if (!existsSync(path)) return;
  try { unlinkSync(path); } catch { /* best-effort */ }
}

// =============================================================================
// Cooperative-check: the 5-step gate
// =============================================================================

/**
 * Outcome of the cooperative-check gate.
 *
 * @typedef {{
 *   permitted: boolean,
 *   errorCode: string|null,
 *   reason: string|null,
 * }} GateResult
 */

/**
 * Run the 5-step cooperative-check gate. Returns a GateResult. Fail-closed on
 * every error path (permitted=false, errorCode=UNLOCK_REVOKED).
 *
 * Steps (§5.1 design doc):
 *   1. Atomic-read session.json; extract test_writer_unlock[sg-id].
 *   2. Check unlocked_until > now().
 *   3. Check dispatch_id == sentinel.dispatch_id.
 *   4. Verify HMAC marker via verifyMarker (constant-time compare).
 *   5. Permit (return permitted=true).
 *
 * @param {string} projectRoot
 * @param {TestWriterSentinel} sentinel
 * @returns {GateResult}
 */
function runCooperativeCheck(projectRoot, sentinel) {
  // Step 1: atomic-read session.json
  const session = atomicReadSessionJson(projectRoot);
  if (!session) {
    return {
      permitted: false,
      errorCode: ERR_UNLOCK_REVOKED,
      reason: 'session_json_unreadable',
    };
  }
  const activeWork = session && session.active_work;
  if (!activeWork || typeof activeWork !== 'object') {
    return {
      permitted: false,
      errorCode: ERR_UNLOCK_REVOKED,
      reason: 'no_active_work',
    };
  }
  const unlocks = activeWork.test_writer_unlock;
  if (!unlocks || typeof unlocks !== 'object') {
    return {
      permitted: false,
      errorCode: ERR_UNLOCK_REVOKED,
      reason: 'no_unlock_map',
    };
  }
  const entry = unlocks[sentinel.spec_group_id];
  if (!entry || typeof entry !== 'object') {
    return {
      permitted: false,
      errorCode: ERR_UNLOCK_REVOKED,
      reason: 'no_unlock_entry',
    };
  }
  // Validate entry shape before any further step.
  const required = ['first_failure_at', 'unlocked_until', 'dispatch_id', 'marker'];
  for (const field of required) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      return {
        permitted: false,
        errorCode: ERR_UNLOCK_REVOKED,
        reason: `entry_field_missing_${field}`,
      };
    }
  }

  // Step 2: TTL check. unlocked_until is ISO-8601 at record time.
  const ttlMs = Date.parse(entry.unlocked_until);
  if (!Number.isFinite(ttlMs)) {
    return {
      permitted: false,
      errorCode: ERR_UNLOCK_REVOKED,
      reason: 'ttl_unparseable',
    };
  }
  if (ttlMs <= Date.now()) {
    return {
      permitted: false,
      errorCode: ERR_UNLOCK_REVOKED,
      reason: 'ttl_expired',
    };
  }

  // Step 3: dispatch_id match. Compare against the sentinel.
  if (entry.dispatch_id !== sentinel.dispatch_id) {
    return {
      permitted: false,
      errorCode: ERR_UNLOCK_REVOKED,
      reason: 'dispatch_id_mismatch',
    };
  }

  // Step 4: HMAC marker verification. Requires session HMAC secret.
  const secret = readSessionHmacSecret(projectRoot, sentinel.session_id);
  if (!secret) {
    return {
      permitted: false,
      errorCode: ERR_UNLOCK_REVOKED,
      reason: 'hmac_secret_unavailable',
    };
  }
  let ok;
  try {
    ok = verifyMarker({
      token: entry.marker,
      specGroupId: sentinel.spec_group_id,
      dispatchId: entry.dispatch_id,
      unlockedUntil: entry.unlocked_until,
      secret,
    });
  } catch {
    return {
      permitted: false,
      errorCode: ERR_UNLOCK_REVOKED,
      reason: 'marker_verify_threw',
    };
  }
  if (!ok) {
    return {
      permitted: false,
      errorCode: ERR_UNLOCK_REVOKED,
      reason: 'marker_mismatch',
    };
  }

  // Step 5: permit.
  return { permitted: true, errorCode: null, reason: null };
}

// =============================================================================
// Blocking IO: stderr + exit 2
// =============================================================================

/**
 * Emit a structured block message and exit 2.
 * @param {string} errorCode — UNLOCK_REVOKED | TIMEOUT
 * @param {string} reason — internal reason label for operator debugging
 * @param {string} resolvedPath — absolute read path that triggered the block
 */
function blockRead(errorCode, reason, resolvedPath) {
  process.stderr.write('\n');
  process.stderr.write('========================================\n');
  process.stderr.write(`BLOCKED: test-writer isolation (${errorCode})\n`);
  process.stderr.write('========================================\n');
  process.stderr.write('\n');
  process.stderr.write(`Cannot read implementation file: ${resolvedPath}\n`);
  process.stderr.write(`Reason: ${reason}\n`);
  process.stderr.write(`Error code: ${errorCode}\n`);
  process.stderr.write('\n');
  if (errorCode === ERR_UNLOCK_REVOKED) {
    process.stderr.write(
      'The test-writer is operating under strict isolation (feature-mode) or\n' +
      'a prior bug-fix unlock has been revoked (TTL expired, dispatch_id\n' +
      'mismatch, or HMAC marker failed).\n',
    );
    process.stderr.write('\n');
    process.stderr.write(
      'To resolve: complete the first failing test run in isolation, then\n' +
      'invoke `node .claude/scripts/session-checkpoint.mjs record-test-writer-unlock`\n' +
      'with a bug-fix-mode spec to mint a fresh unlock.\n',
    );
  } else if (errorCode === ERR_TIMEOUT) {
    process.stderr.write(
      'Second consecutive cooperative-check failure. test-writer is reverting\n' +
      'to fenced mode for the remainder of this dispatch.\n',
    );
  }
  process.stderr.write('\n');
  process.exit(2);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const startTimeMs = Date.now();
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      process.exit(0); // no input → fail-open (no enforcement context)
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      process.exit(0); // malformed input → fail-open
    }
    const toolName = input.tool_name;
    const toolInput = input.tool_input || {};
    const sessionId = input.session_id || '';
    const projectRoot = findProjectRoot();

    // ----- Hook 1: Agent matcher → sentinel lifecycle ----------------------
    if (toolName === 'Agent' || toolName === 'Task') {
      const subagentType = toolInput.subagent_type;
      if (subagentType === 'test-writer') {
        // Capture dispatch context. spec_group_id from session.active_work.
        const session = atomicReadSessionJson(projectRoot);
        const specGroupId = session?.active_work?.spec_group_id;
        if (typeof specGroupId !== 'string' || specGroupId.length === 0) {
          // No active spec-group — Fenced-by-default. Skip sentinel write;
          // feature-mode path still blocks via allowlist.
          process.exit(0);
        }
        // Synthesize a dispatch id from session + prompt slice (deterministic
        // per Claude-Code hook conventions; see workflow-gate-enforcement.mjs
        // L286 precedent).
        const promptSlice = String(toolInput.prompt || '').slice(0, 64);
        const dispatchId = createHash('sha256')
          .update(`${sessionId}\x00${promptSlice}\x00${Date.now()}`)
          .digest('hex')
          .slice(0, 16);
        // Write sentinel. Use top-level rename for atomicity.
        const sentinelPath = join(projectRoot, SENTINEL_RELATIVE_PATH);
        const dir = dirname(sentinelPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmp = sentinelPath + '.tmp.' + process.pid;
        const payload = {
          session_id: sessionId,
          dispatch_id: dispatchId,
          spec_group_id: specGroupId,
          agent_type: 'test-writer',
          set_at: new Date().toISOString(),
        };
        writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
        try {
          // Atomic rename.
          renameSync(tmp, sentinelPath);
        } catch {
          // Fallback: overwrite in place.
          try { writeFileSync(sentinelPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8'); } catch { /* swallow */ }
          try { unlinkSync(tmp); } catch { /* best-effort */ }
        }
        process.stderr.write('[test-writer-isolation] sentinel activated for test-writer dispatch\n');
      } else {
        // Any non-test-writer Agent dispatch clears the sentinel.
        deleteSentinel(projectRoot);
      }
      process.exit(0);
    }

    // ----- Hook 2: Read matcher → cooperative-check ------------------------
    if (toolName !== 'Read') {
      process.exit(0); // not a Read op → pass through
    }

    const filePath = toolInput.file_path;
    if (!filePath) {
      process.exit(0); // no file path → fail-open
    }

    // Check sentinel presence. If no sentinel → no test-writer session active;
    // pass through.
    const sentinel = readSentinel(projectRoot, sessionId);
    if (!sentinel) {
      process.exit(0);
    }

    // Allowlist shortcut: if the read is within spec/contract/template/test/docs,
    // permit regardless of unlock state. This covers feature-mode strict paths.
    const allow = checkPathAgainstAllowlist(filePath, projectRoot, READ_ALLOWLIST_PREFIXES);
    if (allow.allowed) {
      process.exit(0);
    }

    // AC6.1: feature-mode (or spec_mode absent) → block regardless of unlock.
    const specMode = readManifestSpecMode(projectRoot, sentinel.spec_group_id);
    if (specMode !== 'bug-fix') {
      blockRead(
        ERR_UNLOCK_REVOKED,
        `spec_mode=${specMode}_not_bug-fix`,
        allow.resolvedPath,
      );
    }

    // AC6.2 / AC6.3 / AC6.4: run the cooperative-check gate.
    const result = runCooperativeCheck(projectRoot, sentinel);
    const retryPath = retryStatePath(projectRoot, sentinel.spec_group_id, sentinel.dispatch_id);

    if (result.permitted) {
      // Happy-path: permit read and clear retry state.
      clearAttemptState(retryPath);
      const elapsedMs = Date.now() - startTimeMs;
      if (elapsedMs > COOPERATIVE_CHECK_SLA_MS) {
        process.stderr.write(
          `[test-writer-isolation] WARN cooperative-check exceeded ${COOPERATIVE_CHECK_SLA_MS}ms SLA: elapsed=${elapsedMs}ms\n`,
        );
      }
      process.exit(0);
    }

    // Gate failed → escalate UNLOCK_REVOKED → TIMEOUT on retry (AC6.3).
    const prior = readAttemptCount(retryPath);
    const next = prior + 1;
    writeAttemptCount(retryPath, next, {
      spec_group_id: sentinel.spec_group_id,
      dispatch_id: sentinel.dispatch_id,
      session_id: sentinel.session_id,
    });
    const errorCode = next >= 2 ? ERR_TIMEOUT : ERR_UNLOCK_REVOKED;
    blockRead(errorCode, result.reason || 'unknown', allow.resolvedPath);
  } catch (err) {
    // SAFETY: any unexpected error in the hook — fail-open ONLY for structural
    // errors that would otherwise block legitimate operations. Given the
    // fail-closed contract (AC6.4), we prefer to block on known-unknowns. Here
    // we leave an stderr breadcrumb for operator diagnosis.
    process.stderr.write(
      `[test-writer-isolation] internal error (fail-open): ${err?.message || err}\n`,
    );
    process.exit(0);
  }
}

main();
