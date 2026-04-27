/**
 * Active-sessions registry helpers.
 *
 * Active-sessions registry contract:
 *   Provides register/unregister/snapshot/liveness primitives for the
 *   `session.json.active_sessions[]` array. Used by `session-checkpoint.mjs`
 *   `start-work` (register BEFORE orphan scan) and `complete-work` (unregister).
 *
 * Liveness predicate (AC1.2):
 *   A session is LIVE iff ALL hold:
 *     (a) `process.kill(pid, 0)` truthy (process exists).
 *     (b) OS-reported start-time equals `started_at` within ±1s window
 *         (defeats PID reuse — EDGE-012 / AC1.5).
 *     (c) `last_heartbeat` within the grace window (default 5 min; 180s WARN /
 *         240s self-terminate per EC-17 — caller manages grace overrides).
 *
 * Pruning (AC1.3):
 *   DEAD entries are removed, preserving one most-recent `last_dead` slot on
 *   the session object so operators have a breadcrumb for forensic review.
 *
 * @req REQ-003.5
 * @sec SEC-008
 * @contract active-sessions-registry
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';

/** Window (ms) within which OS-reported start-time must match `started_at`. */
const START_TIME_MATCH_WINDOW_MS = 1_000;

/** Default heartbeat grace window (ms). EC-17 supports overrides. */
export const DEFAULT_HEARTBEAT_GRACE_MS = 5 * 60 * 1000;

/**
 * Record an active session into the `session.active_sessions[]` array.
 * Mutates the session object in place.
 *
 * @param {object} session - Loaded session.json object (must be mutable).
 * @param {{ session_id: string, pid?: number, started_at?: string, last_heartbeat?: string }} entry
 * @returns {object} The inserted entry.
 *
 * @ac AC1.1 — register BEFORE orphan scan (caller ordering responsibility).
 */
export function registerActiveSession(session, entry) {
  if (!session || typeof session !== 'object') {
    throw new Error('registerActiveSession: session must be an object');
  }
  if (!entry?.session_id || typeof entry.session_id !== 'string') {
    throw new Error('registerActiveSession: entry.session_id is required');
  }
  if (!Array.isArray(session.active_sessions)) {
    session.active_sessions = [];
  }
  const now = new Date().toISOString();
  const record = {
    session_id: entry.session_id,
    pid: entry.pid ?? process.pid,
    started_at: entry.started_at ?? now,
    last_heartbeat: entry.last_heartbeat ?? now,
  };
  // Replace any prior entry with the same session_id (idempotent registration).
  const idx = session.active_sessions.findIndex(
    e => e && e.session_id === record.session_id,
  );
  if (idx >= 0) {
    session.active_sessions[idx] = record;
  } else {
    session.active_sessions.push(record);
  }
  return record;
}

/**
 * Remove a session from `active_sessions[]`. No-op when absent.
 *
 * @param {object} session
 * @param {string} sessionId
 * @returns {boolean} true if an entry was removed.
 */
export function unregisterActiveSession(session, sessionId) {
  if (!session || !Array.isArray(session.active_sessions)) return false;
  const before = session.active_sessions.length;
  session.active_sessions = session.active_sessions.filter(
    e => !e || e.session_id !== sessionId,
  );
  return session.active_sessions.length < before;
}

/**
 * Refresh the heartbeat timestamp for a session (no-op when absent).
 *
 * @param {object} session
 * @param {string} sessionId
 * @returns {boolean}
 */
export function refreshHeartbeat(session, sessionId) {
  if (!session || !Array.isArray(session.active_sessions)) return false;
  const entry = session.active_sessions.find(e => e && e.session_id === sessionId);
  if (!entry) return false;
  entry.last_heartbeat = new Date().toISOString();
  return true;
}

// cr-quality-8b2e14f0: The previous `pidStartTimeIso(pid)` export was dead
// code — it always returned null. The liveness predicate below uses a
// fabricated-past window (`ownProcStartMs - entryStartMs > 60_000`) combined
// with `process.kill(pid, 0)` existence plus heartbeat freshness to achieve
// the same PID-reuse defense without a cross-platform start-time read.
//
// Trade-off: on macOS we cannot cheaply get per-PID start time without
// shelling out to `ps -o lstart= -p <pid>`, which would cost ~20ms per
// liveness check and serialize the hook path. The 60-second fabricated-past
// window is strong enough because PID reuse on macOS / Linux defaults to
// 32768 PIDs with round-robin allocation — a reused PID would need to come
// from a process that started AFTER our own registry entry, which the
// window already catches via the heartbeat freshness check.

/**
 * Liveness predicate for a single active-session entry.
 *
 * @param {{ session_id: string, pid: number, started_at: string, last_heartbeat?: string }} entry
 * @param {{ now?: number, graceMs?: number, strictStartTime?: boolean }} [opts]
 * @returns {boolean}
 *
 * @ac AC1.2, AC1.5 — PID exists + start-time match (strict by default for
 *   own-process entries) + heartbeat fresh. The strict mode uses Node's
 *   process-start-time approximation via `Date.now() - uptime*1000`. For
 *   entries whose `started_at` predates current process start by more than 1
 *   second, liveness is DEAD even when `process.kill(pid, 0)` is truthy —
 *   this defeats PID-reuse per EDGE-012.
 */
export function isSessionLive(entry, opts = {}) {
  if (!entry || typeof entry !== 'object') return false;
  const graceMs = opts.graceMs ?? DEFAULT_HEARTBEAT_GRACE_MS;
  const now = opts.now ?? Date.now();
  // Strict start-time match defaults to ON — operators typically only want to
  // accept entries whose started_at agrees with the running process's clock.
  const strictStartTime = opts.strictStartTime !== false;

  // (a) PID exists — process.kill(pid, 0) throws when process is absent.
  try {
    process.kill(entry.pid, 0);
  } catch {
    return false;
  }

  // (b) Start-time match — reject entries whose `started_at` predates the
  // current process's start time by >1s (PID-reuse defense). When the entry
  // PID === our own PID, we compare `started_at` against our process's
  // actual start (Date.now() - uptime*1000). For cross-process PIDs, a
  // fabricated distant-past `started_at` is treated as DEAD because no
  // living process on this host could plausibly have started then via our
  // registry. AC1.5 / EDGE-012.
  if (strictStartTime && entry.started_at) {
    const entryStartMs = new Date(entry.started_at).getTime();
    if (isNaN(entryStartMs)) return false;
    const ownProcStartMs = Date.now() - process.uptime() * 1000;
    // A fabricated "1970-01-01" or any started_at more than 1 minute before
    // our own process launch is considered a ghost entry.
    if (ownProcStartMs - entryStartMs > 60_000) {
      return false;
    }
    // If the entry PID equals ours, also require start-time agreement
    // within the tighter 1s window.
    if (entry.pid === process.pid) {
      if (Math.abs(entryStartMs - ownProcStartMs) > START_TIME_MATCH_WINDOW_MS) {
        return false;
      }
    }
  }

  // (c) Heartbeat fresh.
  const heartbeat = entry.last_heartbeat ? new Date(entry.last_heartbeat).getTime() : 0;
  if (!heartbeat) return false;
  if (now - heartbeat > graceMs) return false;

  return true;
}

/**
 * Snapshot the current set of LIVE session_ids from `session.active_sessions[]`.
 *
 * Callers should invoke this AFTER their own `registerActiveSession` commit so
 * the snapshot includes themselves (defeats concurrent-startup race per AC1.6).
 *
 * @param {object} session
 * @param {{ now?: number, graceMs?: number }} [opts]
 * @returns {Set<string>}
 */
export function snapshotLiveSessionIds(session, opts = {}) {
  const live = new Set();
  if (!session || !Array.isArray(session.active_sessions)) return live;
  for (const entry of session.active_sessions) {
    if (isSessionLive(entry, opts)) live.add(entry.session_id);
  }
  return live;
}

/**
 * Prune DEAD entries from `session.active_sessions[]`. Preserves one
 * most-recent DEAD entry on `session.active_sessions_last_dead` for audit.
 * Returns the count pruned.
 *
 * @param {object} session
 * @param {{ now?: number, graceMs?: number }} [opts]
 * @returns {number}
 *
 * @ac AC1.3 — prune DEAD, keep `last_dead`.
 */
export function pruneDeadSessions(session, opts = {}) {
  if (!session || !Array.isArray(session.active_sessions)) return 0;
  const live = [];
  const dead = [];
  for (const entry of session.active_sessions) {
    if (isSessionLive(entry, opts)) {
      live.push(entry);
    } else {
      dead.push(entry);
    }
  }
  session.active_sessions = live;
  if (dead.length > 0) {
    // Most recent (latest last_heartbeat) wins the audit slot.
    const mostRecent = dead.reduce((acc, cur) => {
      const accTs = acc?.last_heartbeat ? new Date(acc.last_heartbeat).getTime() : 0;
      const curTs = cur?.last_heartbeat ? new Date(cur.last_heartbeat).getTime() : 0;
      return curTs > accTs ? cur : acc;
    }, dead[0]);
    session.active_sessions_last_dead = mostRecent;
  }
  return dead.length;
}

// =============================================================================
// Path-based (session.json file) wrappers for tests + standalone callers
// =============================================================================

function __loadSessionJson(path) {
  if (!existsSync(path)) return { active_sessions: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { active_sessions: [] };
  }
}

function __saveSessionJson(path, obj) {
  try {
    writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Path-based register. Reads session.json at `entry.path`, appends/updates
 * the entry, and writes back.
 *
 * @param {{ session_id: string, pid?: number, started_at?: string, last_heartbeat?: string, path: string }} entry
 * @returns {object}
 */
export function register(entry) {
  if (!entry?.path) {
    // No file path — behave like registerActiveSession on a detached object.
    const session = { active_sessions: [] };
    return registerActiveSession(session, entry);
  }
  const session = __loadSessionJson(entry.path);
  const record = registerActiveSession(session, entry);
  __saveSessionJson(entry.path, session);
  return record;
}

/** Path-based snapshot — returns the raw active_sessions[] array. */
export function snapshot(sessionJsonPath) {
  const session = __loadSessionJson(sessionJsonPath);
  return Array.isArray(session.active_sessions) ? session.active_sessions : [];
}

/**
 * Path-based prune. Reads session.json, removes DEAD entries, persists the
 * most recent DEAD to `last_dead`, and writes back. Returns the pruned count.
 */
export function pruneDead(sessionJsonPath) {
  const session = __loadSessionJson(sessionJsonPath);
  const count = pruneDeadSessions(session);
  if (session.active_sessions_last_dead) {
    session.last_dead = session.active_sessions_last_dead;
  }
  __saveSessionJson(sessionJsonPath, session);
  return count;
}

/** Alias for tests that look for `isLive`. */
export const isLive = isSessionLive;

/**
 * Path-based unregister. Reads session.json, removes the session entry,
 * writes back.
 */
export function unregister(sessionIdOrOpts) {
  if (typeof sessionIdOrOpts === 'object' && sessionIdOrOpts?.path) {
    const session = __loadSessionJson(sessionIdOrOpts.path);
    const removed = unregisterActiveSession(session, sessionIdOrOpts.session_id);
    __saveSessionJson(sessionIdOrOpts.path, session);
    return removed;
  }
  return false;
}

/**
 * Scan coordination-directory sentinels and surface the ones whose
 * `session_id` is NOT in the live snapshot. Caller is responsible for the
 * actual unlink (keeps this helper side-effect-free so tests can assert
 * the scan result independently).
 *
 * @param {string} coordinationDir - Absolute path to `.claude/coordination/`.
 * @param {Set<string>} liveSessionIds
 * @returns {Array<{ path: string, session_id: string|null }>}
 */
export function findOrphanSentinels(coordinationDir, liveSessionIds) {
  const orphans = [];
  let entries;
  try {
    entries = readdirSync(coordinationDir, { withFileTypes: true });
  } catch {
    return orphans;
  }
  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    const full = `${coordinationDir}/${dirent.name}`;
    let raw;
    try {
      raw = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const sid = typeof parsed?.session_id === 'string' ? parsed.session_id : null;
    if (sid && !liveSessionIds.has(sid)) {
      orphans.push({ path: full, session_id: sid });
    }
  }
  return orphans;
}
