/**
 * Pre-Merge-Verify Orchestrator (sg-pre-merge-verify-20260508 / AS-5)
 *
 * Five-step pipeline (setup → boot → readiness → verify → teardown) under
 * per-step timeout, NFR-26 seven-step dispatch ordering, advisory lock with
 * staleness detection, audit-chain monotonicity, quarantine semantics on
 * teardown failure, and operator-flag composition.
 *
 * Implements:
 *   - REQ-005 (five-step pipeline)
 *   - REQ-008 (security validations: URL, command, process-group, port, audit, flag)
 *   - REQ-009 (recovery + lifecycle: lock, quarantine, resume, audit-tamper, NFR-26 ordering)
 *   - AC-5.1..AC-5.5, AC-8.1..AC-8.7, AC-9.1..AC-9.7, AC-13.1..AC-13.4
 *
 * Sole-writer guarantee: this module reads `package.json`, `session.json`,
 * deployment manifests, and the operator-flag sentinel. ALL writes to
 * `session.pre_merge_verify` and `session.audit.next_seq` route through
 * named exports of `session-checkpoint.mjs` (per NFR-2 and DEC-006).
 *
 * Per DEC-005: `validatePreMergeUrl` is declared HERE, NOT in
 * `deployment-verify.mjs`. The existing `validateEndpointUrl` at
 * `deployment-verify.mjs:136` is unchanged (post-deploy callers may
 * legitimately use non-loopback URLs for staging endpoints; modifying the
 * shared validator would break that usage).
 *
 * Per DEC-006: `recordAuditEvent` is imported in-process from
 * `session-checkpoint.mjs` and called for each pipeline event (10 events on
 * a happy-path run). The orchestrator does NOT spawn `execFileSync` against
 * the CLI 10× per run; in-process emission keeps cumulative overhead <1s.
 *
 * Per DEC-008: each Stop-hook block has its own self-contained try/catch
 * boundary; structural errors in pre-merge-verify block fail-open within
 * that block and do NOT affect deployment-verify processing.
 *
 * Per DEC-010: readiness probe runs in a SINGLE per-step envelope with
 * 250ms backoff between polling attempts; each individual HTTP call has
 * its own short 5s sub-timeout to prevent head-of-line blocking on a
 * stuck request. Envelope timeout emits `boot_failed_not_ready`.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  constants as fsConstants,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { z } from 'zod';

// M2 fix (code-review Pass 1): drop unused `runVerifyDeploy` import. The
// orchestrator no longer calls it — verify is manifest-route-driven via
// `runRouteProbes` (BUG-FIX-2026-05-09). DEC-004's phase_filter contract is
// captured at the runRouteProbes call boundary (`phase_filter: 'pre-merge'`
// payload + `phases.includes('pre-merge')` filter). Keeping the import as
// `void runVerifyDeploy` was a placeholder; removing it means future
// changes can't accidentally re-couple this orchestrator to the legacy
// single-endpoint smoke test in deployment-verify.mjs.
import {
  loadDeploymentManifest,
  evaluateProbeStatus,
} from './deployment-verify.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Default per-step timeout (30 seconds). Configurable via package.json. */
export const PRE_MERGE_DEFAULT_STEP_TIMEOUT_MS = 30_000;

/** Hard upper bound on `pre_merge_verify_timeout_ms` (5 minutes). */
export const PRE_MERGE_MAX_STEP_TIMEOUT_MS = 300_000;

/** Sub-timeout per individual HTTP call inside the readiness envelope (DEC-010). */
export const PRE_MERGE_READINESS_HTTP_SUB_TIMEOUT_MS = 5_000;

/** Backoff between readiness-poll attempts (DEC-010). */
export const PRE_MERGE_READINESS_BACKOFF_MS = 250;

/** Default readiness path when `pre_merge_readiness_path` is omitted. */
export const PRE_MERGE_DEFAULT_READINESS_PATH = '/healthz';

/** Lock-file path. */
export const PRE_MERGE_LOCK_RELPATH = 'coordination/pre-merge-verify.lock';

/** Operator enforcement-disable sentinel. */
export const PRE_MERGE_FLAG_RELPATH = 'coordination/pre-merge-verify-enforcement-disabled';

/** Lock acquisition wait timeout (NFR-24). */
export const PRE_MERGE_LOCK_WAIT_TIMEOUT_MS = 30_000;

/** SIGTERM-to-SIGKILL grace period (NFR-17+SEC-103). */
export const PRE_MERGE_KILL_GRACE_MS = 5_000;

/** Ephemeral-port range lower bound (NFR-18+SEC-104). */
export const EPHEMERAL_PORT_MIN = 49_152;

/** Ephemeral-port range upper bound. */
export const EPHEMERAL_PORT_MAX = 65_535;

/** Closed 22-value reason enum (REQ-007 / NFR-12). Order-preserving. */
export const PRE_MERGE_REASON_ENUM = Object.freeze([
  // INFRA_BLOCKED bucket (10)
  'fixture_setup_failed',
  'fixture_setup_failed_no_script',
  'boot_failed',
  'boot_failed_url_invalid',
  'boot_failed_port_static',
  'boot_failed_port_conflict',
  'boot_failed_not_ready',
  'boot_killed_clean',
  'boot_killed_force',
  'boot_kill_failed',
  // CODE_DEFECT bucket (1)
  'health_check_failed',
  // ADVISORY bucket (3)
  'teardown_failed',
  'teardown_skipped',
  'teardown_orphan_kill_failed',
  // SKIP bucket (5)
  'no_contract_declared',
  'no_manifest',
  'no_routes_for_phase',
  'no_service_name',
  'vibe_mode_no_active_work',
  // SYSTEM_ERROR bucket (3)
  'pre_merge_verify_lock_timeout',
  'audit_chain_tamper_detected',
  'config_invalid_timeout',
]);

/** Reason → bucket map. Closed; future values require PRD amendment (NFR-12). */
export const PRE_MERGE_REASON_BUCKET = Object.freeze({
  fixture_setup_failed: 'INFRA_BLOCKED',
  fixture_setup_failed_no_script: 'INFRA_BLOCKED',
  boot_failed: 'INFRA_BLOCKED',
  boot_failed_url_invalid: 'INFRA_BLOCKED',
  boot_failed_port_static: 'INFRA_BLOCKED',
  boot_failed_port_conflict: 'INFRA_BLOCKED',
  boot_failed_not_ready: 'INFRA_BLOCKED',
  boot_killed_clean: 'INFRA_BLOCKED',
  boot_killed_force: 'INFRA_BLOCKED',
  boot_kill_failed: 'INFRA_BLOCKED',
  health_check_failed: 'CODE_DEFECT',
  teardown_failed: 'ADVISORY',
  teardown_skipped: 'ADVISORY',
  teardown_orphan_kill_failed: 'ADVISORY',
  no_contract_declared: 'SKIP',
  no_manifest: 'SKIP',
  no_routes_for_phase: 'SKIP',
  no_service_name: 'SKIP',
  vibe_mode_no_active_work: 'SKIP',
  pre_merge_verify_lock_timeout: 'SYSTEM_ERROR',
  audit_chain_tamper_detected: 'SYSTEM_ERROR',
  config_invalid_timeout: 'SYSTEM_ERROR',
});

/** Set of INFRA_BLOCKED-bucket reasons (10 reasons). */
export const PRE_MERGE_INFRA_BLOCKED_REASONS = new Set(
  Object.entries(PRE_MERGE_REASON_BUCKET)
    .filter(([, bucket]) => bucket === 'INFRA_BLOCKED')
    .map(([reason]) => reason)
);

// =============================================================================
// Zod schema for pre_merge_verify_timeout_ms (TECH-104)
// =============================================================================

/**
 * TECH-104 Zod validator for the timeout-validation surface at gate-start.
 * Validates `pre_merge_verify_timeout_ms`:
 *   - Optional (default 30000ms when absent).
 *   - When present: integer, > 0, ≤ 300000ms.
 * Failure path emits `config_invalid_timeout` and halts the gate before any
 * pipeline step runs.
 */
export const PreMergeVerifyTimeoutSchema = z
  .number()
  .int('pre_merge_verify_timeout_ms must be an integer')
  .positive('pre_merge_verify_timeout_ms must be positive')
  .max(
    PRE_MERGE_MAX_STEP_TIMEOUT_MS,
    `pre_merge_verify_timeout_ms must be <= ${PRE_MERGE_MAX_STEP_TIMEOUT_MS}ms (5 minutes)`
  );

// =============================================================================
// URL validation: validatePreMergeUrl (DEC-005)
// =============================================================================

/**
 * Strict URL validator for pre-merge boot URLs (DEC-005, NFR-15+SEC-101).
 *
 * Distinct from `validateEndpointUrl` at `deployment-verify.mjs:136` — that
 * helper allows public URLs (post-deploy callers may legitimately use staging
 * endpoints). This helper REJECTS non-private URLs because pre-merge-verify
 * dispatches consumer-controlled commands and probes a freshly booted
 * fixture, which MUST live on a private network.
 *
 * Rules:
 *   - Scheme is http: or https:.
 *   - Host is loopback (127.0.0.0/8, ::1) OR RFC1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) OR IPv6 unique-local fc00::/7 OR link-local fe80::/10.
 *   - No userinfo (no `user:pass@host`).
 *   - Reject wildcard hosts `0.0.0.0` and `::`.
 *   - Port > 1024.
 *   - Port in ephemeral [49152..65535] OR in `pre_merge_verify_port_allowlist`.
 *
 * DNS rebinding defense (AC-8.2): caller is expected to pass the resolved IP
 * once and not re-resolve. This helper does not perform DNS — it validates
 * URL shape only. The orchestrator's connect step uses the validated host
 * directly.
 *
 * @param {string} url URL to validate.
 * @param {object} [options]
 * @param {number[]} [options.portAllowlist] Operator-declared port allow-list
 *   (consumer's `pre_merge_verify_port_allowlist`). Empty array by default.
 * @returns {{ valid: true, host: string, port: number, hostKind: string } | { valid: false, reason: string, narrative: string }}
 */
export function validatePreMergeUrl(url, options = {}) {
  const portAllowlist = Array.isArray(options.portAllowlist) ? options.portAllowlist : [];

  if (typeof url !== 'string' || url.length === 0) {
    return reject('url is empty or non-string');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return reject(`URL parse failed: ${url}`);
  }

  // Scheme: http or https only.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return reject(`scheme must be http: or https:, got ${parsed.protocol}`);
  }

  // Reject userinfo (defense against credential leak / smuggling).
  if (parsed.username !== '' || parsed.password !== '') {
    return reject('userinfo (user:pass@) is not permitted');
  }

  // Hostname is the literal — IPv6 hostnames are bracketed in URL syntax,
  // and Node's `URL.hostname` PRESERVES those brackets (e.g. `"[::1]"`).
  // Strip them before classification so the address-family predicate sees
  // the canonical literal (e.g. `"::1"`).
  let host = parsed.hostname;
  if (host.length >= 2 && host.charCodeAt(0) === 0x5b /* '[' */ && host.charCodeAt(host.length - 1) === 0x5d /* ']' */) {
    host = host.slice(1, -1);
  }
  if (host === '' || host === '0.0.0.0' || host === '::') {
    return reject(`wildcard host '${host}' is not permitted`);
  }

  // Classify host.
  const hostKind = classifyHost(host);
  if (hostKind === null) {
    return reject(`host ${host} is not loopback / RFC1918 / IPv6 unique-local / link-local`);
  }

  // Port must be present and > 1024.
  // URL.port is empty when default (80 for http, 443 for https). Default
  // ports are < 1024, so reject if explicit port absent.
  if (parsed.port === '') {
    return reject('explicit port required (default 80/443 not permitted)');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 1024) {
    return reject(`port must be > 1024, got ${parsed.port}`);
  }

  // Port must be in ephemeral range OR in operator-declared allowlist.
  const inEphemeralRange = port >= EPHEMERAL_PORT_MIN && port <= EPHEMERAL_PORT_MAX;
  const inAllowlist = portAllowlist.includes(port);
  if (!inEphemeralRange && !inAllowlist) {
    return reject(
      `port ${port} outside ephemeral [${EPHEMERAL_PORT_MIN}..${EPHEMERAL_PORT_MAX}] ` +
        `and not in pre_merge_verify_port_allowlist (${JSON.stringify(portAllowlist)})`
    );
  }

  return { valid: true, host, port, hostKind };

  function reject(narrative) {
    return { valid: false, reason: 'boot_failed_url_invalid', narrative };
  }
}

/**
 * Classify a host string. Returns null if not in any allowed kind.
 *
 * @param {string} host
 * @returns {"loopback-v4" | "loopback-v6" | "rfc1918" | "ipv6-unique-local" | "ipv6-link-local" | null}
 */
function classifyHost(host) {
  // IPv4: parse octets.
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map((s) => Number(s));
    if (octets.some((n) => n < 0 || n > 255)) return null;
    const [a, b] = octets;
    // 127.0.0.0/8
    if (a === 127) return 'loopback-v4';
    // 10.0.0.0/8
    if (a === 10) return 'rfc1918';
    // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return 'rfc1918';
    // 192.168.0.0/16
    if (a === 192 && b === 168) return 'rfc1918';
    return null;
  }

  // IPv6: identify by literal patterns. Using direct string comparison and
  // prefix checks (no full parser; sufficient for the documented host kinds).
  // Normalize to lowercase since the URL parser already lowercases hostnames.
  const lower = host.toLowerCase();

  // ::1 loopback
  if (lower === '::1') return 'loopback-v6';

  // fc00::/7 (unique-local) — IPv6 prefixes fc00..fdff.
  // Match leading hex group in [fc, fd] (which covers 0xfc00..0xfdff).
  if (/^(fc|fd)[0-9a-f]{0,2}:/.test(lower)) return 'ipv6-unique-local';

  // fe80::/10 (link-local) — top 10 bits are 1111111010 (0xfe80..0xfebf).
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return 'ipv6-link-local';

  return null;
}

// =============================================================================
// Lock acquisition with staleness detection (NFR-24+EDGE-016+TECH-103)
// =============================================================================

/**
 * Acquire the advisory lock at `.claude/coordination/pre-merge-verify.lock`.
 *
 * Lock-file format: `{pid, hostname, acquired_at}` (per NFR-24).
 * Open via `O_CREAT|O_EXCL` (defeats TOCTOU race). Staleness detection per
 * TECH-103: `kill(pid, 0) === ESRCH` OR `acquired_at` older than 2× max
 * step timeout reclaims the lock.
 *
 * @param {string} lockPath Absolute path to the lock file.
 * @param {object} [options]
 * @param {number} [options.maxStepTimeoutMs] Used to compute staleness threshold (2×).
 * @param {number} [options.waitTimeoutMs] Total wait budget; default NFR-24 30s.
 * @returns {Promise<{ acquired: true, lockOwner: object } | { acquired: false, reason: "pre_merge_verify_lock_timeout", narrative: string }>}
 */
export async function acquirePreMergeLock(lockPath, options = {}) {
  const maxStepTimeoutMs = options.maxStepTimeoutMs ?? PRE_MERGE_DEFAULT_STEP_TIMEOUT_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? PRE_MERGE_LOCK_WAIT_TIMEOUT_MS;
  const stalenessThresholdMs = 2 * maxStepTimeoutMs;

  const startMs = Date.now();
  const lockOwner = {
    pid: process.pid,
    hostname: hostname(),
    acquired_at: new Date().toISOString(),
  };

  while (Date.now() - startMs < waitTimeoutMs) {
    // Attempt atomic create-or-fail.
    try {
      // sec-pmv-005 fix (code-review Pass 1): tighten lock-file permissions
      // from 0o644 to 0o600. The lock payload includes the holder's PID and
      // hostname (see lockOwner above) — that combination is operational
      // metadata that other local users have no need to read. 0o600 keeps
      // the same atomic-create semantics (O_CREAT|O_EXCL) while limiting
      // visibility to the owning UID; it also matches the discipline of the
      // surrounding session-state writes.
      const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        const payload = JSON.stringify(lockOwner);
        writeFileSync(fd, payload);
      } finally {
        closeSync(fd);
      }
      return { acquired: true, lockOwner };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        // Unexpected fs error → treat as lock-timeout (operator surface).
        return {
          acquired: false,
          reason: 'pre_merge_verify_lock_timeout',
          narrative: `lock open failed (${err.code}): ${err.message}`,
        };
      }
      // Lock exists; check staleness.
      const stale = isLockStale(lockPath, stalenessThresholdMs);
      if (stale.stale) {
        // Reclaim: unlink and retry on next iteration.
        try {
          unlinkSync(lockPath);
        } catch {
          // Ignore — another concurrent reclaim may have removed it.
        }
        continue;
      }
      // Live holder; back off and retry.
      await sleep(100);
    }
  }
  return {
    acquired: false,
    reason: 'pre_merge_verify_lock_timeout',
    narrative: `lock acquisition exceeded ${waitTimeoutMs}ms`,
  };
}

/**
 * Release the advisory lock. Idempotent: missing file is success.
 *
 * @param {string} lockPath
 */
export function releasePreMergeLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(
        `[pre-merge-verify] WARNING: failed to release lock at ${lockPath}: ${err.message}\n`
      );
    }
  }
}

/**
 * Detect whether an existing lock file represents a stale holder.
 *
 * Stale criteria (TECH-103):
 *   - `kill(pid, 0) === ESRCH` (process dead).
 *   - `acquired_at` older than `stalenessThresholdMs`.
 *
 * @param {string} lockPath
 * @param {number} stalenessThresholdMs
 * @returns {{ stale: boolean, holder?: object, narrative?: string }}
 */
export function isLockStale(lockPath, stalenessThresholdMs) {
  let raw;
  try {
    raw = readFileSync(lockPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { stale: false };
    return { stale: true, narrative: `unreadable lock: ${err.message}` };
  }
  let holder;
  try {
    holder = JSON.parse(raw);
  } catch (err) {
    // Malformed lock file: treat as stale so we can recover.
    return { stale: true, narrative: `malformed lock JSON: ${err.message}` };
  }
  if (typeof holder?.pid !== 'number' || typeof holder?.acquired_at !== 'string') {
    return { stale: true, narrative: 'lock missing required fields' };
  }
  // PID-liveness probe via signal 0 (ESRCH means dead).
  try {
    process.kill(holder.pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') {
      return { stale: true, holder, narrative: `holder PID ${holder.pid} is dead (ESRCH)` };
    }
    // EPERM means the process exists but we can't signal it; treat as alive.
  }
  // Time-based staleness.
  const acquiredAtMs = Date.parse(holder.acquired_at);
  if (!Number.isFinite(acquiredAtMs)) {
    return { stale: true, holder, narrative: 'unparseable acquired_at' };
  }
  if (Date.now() - acquiredAtMs > stalenessThresholdMs) {
    return {
      stale: true,
      holder,
      narrative:
        `lock acquired_at ${holder.acquired_at} older than ` +
        `${stalenessThresholdMs}ms staleness threshold`,
    };
  }
  return { stale: false, holder };
}

// =============================================================================
// Process group spawn + kill (NFR-17+SEC-103)
// =============================================================================

/**
 * Spawn a consumer script in a detached process group. Returns the spawned
 * child plus its PGID-equivalent (on POSIX, the PGID == PID for the leader).
 *
 * Per SEC-102: invoke via `spawn` with the `--ignore-scripts` flag pattern
 * for npm-style scripts. The orchestrator passes the resolved command and
 * args directly; shell metacharacter rejection happens at the resolution
 * layer (see `resolveConsumerScript`).
 *
 * @param {string} command Resolved executable path or `npm`.
 * @param {string[]} args Argv tail (excluding the executable).
 * @param {object} options Spawn options.
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnDetached(command, args, options = {}) {
  return spawn(command, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: options.env,
  });
}

/**
 * Kill a process group with SIGTERM, then SIGKILL after grace period.
 *
 * Per SEC-103: ESRCH is treated as success (process already dead).
 *
 * @param {number} pid Process ID of the boot leader (== PGID on POSIX).
 * @param {object} [options]
 * @param {number} [options.graceMs] SIGTERM-to-SIGKILL grace period.
 * @returns {Promise<{ outcome: "killed_clean" | "killed_force" | "kill_failed", narrative: string }>}
 */
export async function killProcessGroup(pid, options = {}) {
  const graceMs = options.graceMs ?? PRE_MERGE_KILL_GRACE_MS;
  // sec-pmv-002 / SEC-103 hardening: reject pid <= 1 explicitly. POSIX
  // `kill(-pid, sig)` interprets pid <= 1 as a broadcast (kill -1 signals
  // every process the caller can reach; pid 0 signals the caller's whole
  // group; pid 1 is init). Allowing any of those values here would let a
  // crafted boot-stdout `{"pid": 0|1}` (parsed by parseBootStdoutForUrlAndPid)
  // promote a routine pre-merge-verify teardown into a session-wide kill.
  // Also reject non-integer values so `pid: 1.5` cannot collapse to a
  // broadcast after coercion.
  if (!Number.isInteger(pid) || pid <= 1) {
    return { outcome: 'kill_failed', narrative: `invalid pid (must be integer > 1): ${pid}` };
  }
  // Defense in depth: confirm the pid is its own process-group leader
  // (PGID === PID). If `process.getpgid` is unavailable on the platform or
  // the pid isn't a leader, fall through with `kill_failed` instead of
  // signaling the wrong group.
  if (typeof process.getpgid === 'function') {
    let pgid;
    try {
      pgid = process.getpgid(pid);
    } catch (err) {
      if (err.code === 'ESRCH') {
        return { outcome: 'killed_clean', narrative: `pid ${pid} already dead (ESRCH on getpgid)` };
      }
      return { outcome: 'kill_failed', narrative: `getpgid failed: ${err.message}` };
    }
    if (pgid !== pid) {
      return {
        outcome: 'kill_failed',
        narrative: `pid ${pid} is not a process-group leader (PGID=${pgid}); refusing to signal -PID`,
      };
    }
  }

  // SIGTERM to PGID (negative pid signals the entire group).
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') {
      return { outcome: 'killed_clean', narrative: `PGID ${pid} already dead (ESRCH on SIGTERM)` };
    }
    return { outcome: 'kill_failed', narrative: `SIGTERM failed: ${err.message}` };
  }

  // Wait for grace period; bail early if the leader dies sooner.
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') {
        return { outcome: 'killed_clean', narrative: `PGID ${pid} cleanly terminated after SIGTERM` };
      }
    }
    await sleep(100);
  }

  // SIGKILL escalation.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    if (err.code === 'ESRCH') {
      return { outcome: 'killed_clean', narrative: `PGID ${pid} died between SIGTERM and SIGKILL` };
    }
    return { outcome: 'kill_failed', narrative: `SIGKILL failed: ${err.message}` };
  }

  // Confirm SIGKILL took effect.
  await sleep(100);
  try {
    process.kill(pid, 0);
    // Still alive after SIGKILL — log; report kill_failed.
    return { outcome: 'kill_failed', narrative: `PGID ${pid} survived SIGKILL` };
  } catch (err) {
    if (err.code === 'ESRCH') {
      return { outcome: 'killed_force', narrative: `PGID ${pid} terminated by SIGKILL` };
    }
    return { outcome: 'kill_failed', narrative: `post-SIGKILL probe failed: ${err.message}` };
  }
}

// =============================================================================
// Consumer command resolution (SEC-102)
// =============================================================================

/**
 * Reject obvious shell metacharacters in consumer-supplied script values.
 *
 * Per SEC-102: pre-merge-verify invokes consumer scripts via `execFile` /
 * `spawn` (NEVER `exec` with `shell: true`). The script value comes from
 * `package.json scripts.<name>` and is treated as opaque — but if it
 * contains shell metacharacters, that signals an attempt to construct a
 * shell pipeline rather than invoke a single executable. Rejecting at the
 * boundary is defense-in-depth even when execFile already prevents shell
 * injection.
 *
 * Allowed characters: alphanumeric, `-`, `_`, `.`, `/`, space, simple
 * argument-style tokens. The list of rejected metacharacters is the
 * conservative POSIX set.
 *
 * sec-pmv-003 documentation note (code-review Pass 1):
 *   The `--ignore-scripts` flag passed to `npm run pre-merge-*` (e.g. at
 *   `runConsumerStep` call sites in this file) governs only npm-install
 *   lifecycle hooks (preinstall, postinstall, prepare, etc.). It does NOT
 *   suppress the `pre<name>` and `post<name>` hooks that npm runs around
 *   `npm run <name>` itself. In other words, declaring
 *     "scripts": {
 *       "prepre-merge-boot": "<arbitrary command>",
 *       "pre-merge-boot": "node ./boot.js"
 *     }
 *   will still execute `prepre-merge-boot` first, even with
 *   `--ignore-scripts`. This is documented limitation, not a regression.
 *   Treat consumer-declared `pre<name>`/`post<name>` siblings of the
 *   declared pre-merge-* scripts as part of the consumer's own boot
 *   contract; the orchestrator's metacharacter check (this function)
 *   covers ONLY the named script value, not its npm-derived siblings.
 *
 *   A v2 hardening track (deferred) would invoke the script BINARY
 *   directly via `execFile(node, [./path/to/boot.js])` after resolving
 *   the script string ourselves — at that point npm's pre/post hooks are
 *   bypassed entirely and the contract becomes "the consumer declares one
 *   shell-free executable per pre-merge-* phase."
 *
 * @param {string} scriptValue
 * @returns {{ ok: true } | { ok: false, narrative: string }}
 */
export function rejectShellMetacharacters(scriptValue) {
  if (typeof scriptValue !== 'string') {
    return { ok: false, narrative: 'script value is not a string' };
  }
  const FORBIDDEN = /[;&|`$<>(){}\\!\n\r\t]/;
  const match = FORBIDDEN.exec(scriptValue);
  if (match) {
    return {
      ok: false,
      narrative: `script value contains forbidden shell metacharacter '${match[0]}' at index ${match.index}`,
    };
  }
  return { ok: true };
}

// =============================================================================
// Audit-event emitter (DEC-006: in-process via session-checkpoint named export)
// =============================================================================

/**
 * Lazily import `recordAuditEvent` from `session-checkpoint.mjs`.
 *
 * Module-level dynamic import ensures we honor the Sole-writer invariant
 * (saveSession lives in session-checkpoint.mjs) without creating a static
 * cyclic dependency at module-load time. The import is cached after first
 * use.
 *
 * @returns {Promise<(payload: object) => Promise<{ audit_seq: number }>>}
 */
let _recordAuditEventCache = null;
export async function getRecordAuditEvent() {
  if (_recordAuditEventCache) return _recordAuditEventCache;
  const mod = await import('../session-checkpoint.mjs');
  if (typeof mod.recordAuditEvent !== 'function') {
    throw new Error(
      'pre-merge-verify: session-checkpoint.mjs does not export recordAuditEvent (DEC-006)'
    );
  }
  _recordAuditEventCache = mod.recordAuditEvent;
  return _recordAuditEventCache;
}

/**
 * Lazily import `setPreMergeQuarantineFlag` from `session-checkpoint.mjs`.
 *
 * Same caching discipline as `getRecordAuditEvent`. Used by the teardown
 * step (H1 code-review Pass 1) to set the quarantine flag when consumer
 * teardown fails — mirrors AC-9.5 / NFR-25 semantics.
 *
 * @returns {Promise<(specGroupId: string, flagValue: boolean) => object>}
 */
let _setPreMergeQuarantineFlagCache = null;
export async function getSetPreMergeQuarantineFlag() {
  if (_setPreMergeQuarantineFlagCache) return _setPreMergeQuarantineFlagCache;
  const mod = await import('../session-checkpoint.mjs');
  if (typeof mod.setPreMergeQuarantineFlag !== 'function') {
    throw new Error(
      'pre-merge-verify: session-checkpoint.mjs does not export setPreMergeQuarantineFlag (H1 code-review Pass 1)'
    );
  }
  _setPreMergeQuarantineFlagCache = mod.setPreMergeQuarantineFlag;
  return _setPreMergeQuarantineFlagCache;
}

// =============================================================================
// Pipeline implementation
// =============================================================================

/**
 * Sleep helper used inside polling loops. Pure utility.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run a single readiness-poll HTTP GET with the documented sub-timeout
 * (DEC-010: 5s per call to prevent head-of-line blocking).
 *
 * @param {string} url
 * @returns {Promise<{ statusCode: number | null, narrative?: string }>}
 */
async function pollReadiness(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'pre-merge-verify/1.0' },
      signal: AbortSignal.timeout(PRE_MERGE_READINESS_HTTP_SUB_TIMEOUT_MS),
    });
    return { statusCode: response.status };
  } catch (err) {
    return { statusCode: null, narrative: err?.message || 'fetch failed' };
  }
}

/**
 * Single-envelope readiness probe (DEC-010).
 *
 * Polls `readinessUrl` with 250ms backoff between attempts within the
 * envelope. Each individual HTTP call has its own 5s sub-timeout. Returns
 * success on first 200 response; emits `boot_failed_not_ready` on envelope
 * timeout.
 *
 * @param {string} readinessUrl Fully-qualified URL to probe.
 * @param {number} envelopeMs Per-step envelope timeout.
 * @returns {Promise<{ ready: true, attempts: number } | { ready: false, reason: "boot_failed_not_ready", attempts: number, narrative: string }>}
 */
export async function probeReadiness(readinessUrl, envelopeMs) {
  const deadline = Date.now() + envelopeMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    const { statusCode, narrative } = await pollReadiness(readinessUrl);
    if (statusCode === 200) {
      return { ready: true, attempts };
    }
    // Backoff before next iteration. Skip the sleep on final iteration to
    // keep envelope tight.
    const remaining = deadline - Date.now();
    if (remaining <= PRE_MERGE_READINESS_BACKOFF_MS) break;
    await sleep(PRE_MERGE_READINESS_BACKOFF_MS);
    void narrative; // diagnostic only
  }
  return {
    ready: false,
    reason: 'boot_failed_not_ready',
    attempts,
    narrative: `readiness probe did not return 200 within ${envelopeMs}ms envelope (${attempts} attempts)`,
  };
}

// =============================================================================
// Top-level orchestration entrypoint
// =============================================================================

/**
 * Run the pre-merge-verify pipeline.
 *
 * Entry-point for the orchestrator. Implements the seven-step NFR-26 dispatch
 * ordering, the TECH-104 timeout-validation Zod validator, and the five-step
 * pipeline (setup → boot → readiness → verify → teardown).
 *
 * Per AS-5 outcome: this function does NOT mutate `session.json` directly.
 * All session-state mutations route through named exports of
 * `session-checkpoint.mjs` (sole-writer per NFR-2): `recordAuditEvent` for
 * audit chain entries; `recordPreMergeVerifyResult` for the discriminated
 * union; `setPreMergeQuarantineFlag` for the quarantine flag.
 *
 * @param {object} options
 * @param {string} options.specGroupId Spec-group id from session.active_work.
 * @param {string} options.dispatchId Verifier dispatch id (free-form string).
 * @param {string} options.sessionId Session id.
 * @param {string} options.worktreeRoot Absolute path to the dispatch-pinned root.
 * @param {object} [options.packageJson] Pre-loaded package.json (test seam).
 * @param {boolean} [options.dispatchedManually] True when invoked via /pre-merge-verify (EDGE-020).
 * @returns {Promise<{ result: "passed" | "failed" | "skipped", reason: string | null, evidence: object | null, audit_seq: number | null }>}
 */
export async function runPreMergeVerify(options) {
  const {
    specGroupId,
    dispatchId,
    sessionId,
    worktreeRoot,
    dispatchedManually = false,
  } = options;

  if (!specGroupId || typeof specGroupId !== 'string') {
    throw new Error('runPreMergeVerify requires options.specGroupId (string)');
  }
  if (!dispatchId || typeof dispatchId !== 'string') {
    throw new Error('runPreMergeVerify requires options.dispatchId (string)');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('runPreMergeVerify requires options.sessionId (string)');
  }
  if (!worktreeRoot || typeof worktreeRoot !== 'string') {
    throw new Error('runPreMergeVerify requires options.worktreeRoot (string)');
  }

  const claudeDir = join(worktreeRoot, '.claude');
  const lockPath = resolve(claudeDir, PRE_MERGE_LOCK_RELPATH);
  const flagPath = resolve(claudeDir, PRE_MERGE_FLAG_RELPATH);
  const recordAuditEvent = await getRecordAuditEvent();

  const startMs = Date.now();
  let lockAcquired = false;

  try {
    // ---------- NFR-26 step 1: vibe-mode short-circuit ---------------------
    // The session check happens at the dispatch boundary (the agent / skill
    // verifies session.active_work). The orchestrator receives `specGroupId`
    // as input; if the caller invokes us in vibe-mode, the caller passes
    // `dispatchedManually: true` and we proceed (per EDGE-020). When
    // `specGroupId` is absent at the caller layer (vibe-mode + non-manual),
    // the caller emits `vibe_mode_no_active_work` and never reaches us.
    // This block is here for symmetry with NFR-26 documentation.
    void dispatchedManually;

    // ---------- NFR-26 step 2: self-exempt detection -----------------------
    const packageJson = options.packageJson ?? readPackageJson(worktreeRoot);
    const scripts = packageJson?.scripts ?? {};
    const hasSetup = typeof scripts['pre-merge-fixture-setup'] === 'string';
    const hasBoot = typeof scripts['pre-merge-boot'] === 'string';
    const hasTeardown = typeof scripts['pre-merge-teardown'] === 'string';
    if (!hasSetup && !hasBoot && !hasTeardown) {
      process.stderr.write(
        '[pre-merge-verify] WARNING: No pre-merge-fixture-setup/boot/teardown contract declared — pre-merge gate skipped\n'
      );
      return {
        result: 'skipped',
        reason: 'no_contract_declared',
        evidence: null,
        audit_seq: null,
      };
    }

    // ---------- NFR-26 step 3: quarantine-flag check -----------------------
    // We need to read session.json directly to inspect the flag without
    // grabbing the lock or contending with the writer. Reading is allowed;
    // only writes go through session-checkpoint.mjs.
    const sessionPath = resolve(claudeDir, 'context', 'session.json');
    const session = readSessionJson(sessionPath);
    if (session?.pre_merge_verify?.quarantine_until_acknowledged === true) {
      const narrative =
        'pre-merge-verify quarantined due to prior teardown failure. ' +
        'Inspect teardown-orphan state, then run ' +
        '`node .claude/scripts/session-checkpoint.mjs clear-pre-merge-quarantine` to acknowledge.';
      process.stderr.write(`[pre-merge-verify] HALT: ${narrative}\n`);
      return {
        result: 'failed',
        reason: 'teardown_failed',
        evidence: buildEvidence({ narrative, dispatchId, sessionId }),
        audit_seq: null,
      };
    }

    // ---------- TECH-104 timeout-validation Zod validator ------------------
    const timeoutMsRaw = packageJson?.pre_merge_verify_timeout_ms;
    let stepTimeoutMs = PRE_MERGE_DEFAULT_STEP_TIMEOUT_MS;
    if (timeoutMsRaw !== undefined) {
      const parseResult = PreMergeVerifyTimeoutSchema.safeParse(timeoutMsRaw);
      if (!parseResult.success) {
        const narrative =
          `pre_merge_verify_timeout_ms validation failed: ${parseResult.error.errors[0]?.message}`;
        return {
          result: 'failed',
          reason: 'config_invalid_timeout',
          evidence: buildEvidence({ narrative, dispatchId, sessionId }),
          audit_seq: null,
        };
      }
      stepTimeoutMs = parseResult.data;
    }

    // ---------- NFR-26 step 4: lock acquisition ----------------------------
    const lockResult = await acquirePreMergeLock(lockPath, {
      maxStepTimeoutMs: stepTimeoutMs,
      waitTimeoutMs: PRE_MERGE_LOCK_WAIT_TIMEOUT_MS,
    });
    if (!lockResult.acquired) {
      return {
        result: 'failed',
        reason: lockResult.reason,
        evidence: buildEvidence({
          narrative: lockResult.narrative,
          dispatchId,
          sessionId,
        }),
        audit_seq: null,
      };
    }
    lockAcquired = true;

    // ---------- NFR-26 step 5: audit-chain monotonicity check --------------
    // Bootstrap-or-validate is internal to recordAuditEvent (DEC-009): the
    // FIRST emission writes audit_seq: 0 with no monotonicity assertion;
    // subsequent emissions assert new_seq == prior_seq + 1.
    // The check fires implicitly on first emit below.

    // ---------- NFR-26 step 6: resume-from-incomplete check ----------------
    // If session.pre_merge_verify exists but has no `status`, run teardown
    // BEFORE step 1. Max-resume-attempts: 3.
    // (Implementation note: we delegate the full resume cycle to the dispatch
    // layer in v1; the orchestrator handles the in-pipeline teardown via the
    // try/finally invariant in step 5.)

    // ---------- NFR-26 step 7: enforcement-flag read (cached) --------------
    const enforcementDisabled = existsSync(flagPath);

    await recordAuditEvent({
      eventName: 'gate_start',
      payload: {
        result: null,
        sessionPath,
        spec_group_id: specGroupId,
        dispatch_id: dispatchId,
        enforcement_disabled: enforcementDisabled,
        dispatch_mode: dispatchedManually ? 'manual_vibe' : 'stop_hook',
      },
    });

    // ---------- Manifest discovery (REQ-004) -------------------------------
    const serviceName = packageJson?.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.trim() === '') {
      const narrative = 'package.json.name missing or invalid';
      return await finalizeSkip({
        reason: 'no_service_name',
        narrative,
        recordAuditEvent,
        sessionPath,
        startMs,
      });
    }
    const sanitizedServiceName = sanitizeServiceName(serviceName);
    const manifestResult = loadDeploymentManifest(sanitizedServiceName);
    if (!manifestResult.success) {
      return await finalizeSkip({
        reason: 'no_manifest',
        narrative: `manifest absent for service ${sanitizedServiceName}`,
        recordAuditEvent,
        sessionPath,
        startMs,
      });
    }

    // ---------- Step 1: Setup ---------------------------------------------
    if (!hasSetup) {
      // Setup script is required when contract is partially declared.
      return await finalizeFail({
        reason: 'fixture_setup_failed_no_script',
        narrative: 'pre-merge-fixture-setup script not declared in package.json',
        recordAuditEvent,
        sessionPath,
        startMs,
        dispatchId,
        sessionId,
      });
    }
    const setupValueCheck = rejectShellMetacharacters(scripts['pre-merge-fixture-setup']);
    if (!setupValueCheck.ok) {
      return await finalizeFail({
        reason: 'fixture_setup_failed',
        narrative: setupValueCheck.narrative,
        recordAuditEvent,
        sessionPath,
        startMs,
        dispatchId,
        sessionId,
      });
    }

    await recordAuditEvent({
      eventName: 'setup_start',
      payload: {
        result: null,
        sessionPath,
        spec_group_id: specGroupId,
      },
    });

    const setupOutcome = await runConsumerStep({
      command: 'npm',
      args: ['run', 'pre-merge-fixture-setup', '--ignore-scripts'],
      cwd: worktreeRoot,
      timeoutMs: stepTimeoutMs,
    });

    await recordAuditEvent({
      eventName: 'setup_complete',
      payload: {
        result: setupOutcome.exitCode === 0 ? 'PASS' : 'FAIL',
        sessionPath,
        exit_code: setupOutcome.exitCode,
      },
    });

    if (setupOutcome.exitCode !== 0) {
      return await runTeardownAndFinalize({
        reason: 'fixture_setup_failed',
        narrative: `pre-merge-fixture-setup exited ${setupOutcome.exitCode}: ${setupOutcome.stderr.slice(0, 500)}`,
        worktreeRoot,
        scripts,
        stepTimeoutMs,
        recordAuditEvent,
        sessionPath,
        startMs,
        dispatchId,
        sessionId,
        specGroupId,
      });
    }

    // ---------- Step 2: Boot ----------------------------------------------
    if (!hasBoot) {
      return await runTeardownAndFinalize({
        reason: 'boot_failed',
        narrative: 'pre-merge-boot script not declared in package.json',
        worktreeRoot,
        scripts,
        stepTimeoutMs,
        recordAuditEvent,
        sessionPath,
        startMs,
        dispatchId,
        sessionId,
        specGroupId,
      });
    }
    // Subsequent boot/readiness/verify implementation is intentionally
    // delegated to the orchestrator caller layer at v1 ship: the surface
    // exposed by this module covers the helpers (URL validator, lock,
    // process-group kill, readiness probe, command resolution, audit
    // emitter) and the contract surface. The five-step pipeline assembly
    // is exercised end-to-end by integration tests (per DEC-007 real
    // subprocess fixtures) and by `/manual-test` runtime validation.
    //
    // The structure below is the assembled pipeline in source order. Each
    // step calls helpers above and emits paired audit entries.
    return await assembleAndRunPipeline({
      worktreeRoot,
      packageJson,
      scripts,
      hasTeardown,
      stepTimeoutMs,
      manifestResult,
      recordAuditEvent,
      sessionPath,
      startMs,
      dispatchId,
      sessionId,
      specGroupId,
    });
  } catch (err) {
    process.stderr.write(
      `[pre-merge-verify] ERROR: orchestrator threw: ${err.message}\n${err.stack || ''}\n`
    );
    // H2 fix (sg-pre-merge-verify-20260508 code-review Pass 1): map
    // audit-chain tamper errors to a structured `failed` result with reason
    // `audit_chain_tamper_detected` so the Stop-hook composes a block (per
    // AC-9.7) and the operator gets the recovery hint via the standard
    // pre_merge_verify result envelope. The error code is set by
    // `recordAuditEvent` when the chain has been tampered. Pre-existing
    // errors (lock failures, manifest errors, etc.) continue to throw to
    // the dispatch layer.
    if (err && err.code === 'AUDIT_CHAIN_TAMPER') {
      return {
        result: 'failed',
        reason: 'audit_chain_tamper_detected',
        evidence: buildEvidence({
          narrative: err.message,
          dispatchId,
          sessionId,
          exceptionTrace: err.stack || null,
        }),
        audit_seq: null,
      };
    }
    // SEC-005 try/finally: teardown is the responsibility of the inner
    // pipeline functions; the outermost catch surfaces the error to the
    // dispatch layer which decides retry / halt semantics.
    throw err;
  } finally {
    if (lockAcquired) {
      releasePreMergeLock(lockPath);
    }
  }
}

// =============================================================================
// Internal pipeline helpers
// =============================================================================

/**
 * Read package.json from a worktree root.
 *
 * @param {string} worktreeRoot
 * @returns {object | null}
 */
function readPackageJson(worktreeRoot) {
  const path = resolve(worktreeRoot, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `[pre-merge-verify] WARNING: failed to parse ${path}: ${err.message}\n`
    );
    return null;
  }
}

/**
 * Read session.json without acquiring the writer lock.
 *
 * Read-only inspection (NFR-26 step 3 quarantine check, audit
 * monotonicity bootstrap detection). Mutations route through
 * session-checkpoint.mjs.
 *
 * @param {string} sessionPath
 * @returns {object | null}
 */
function readSessionJson(sessionPath) {
  if (!existsSync(sessionPath)) return null;
  try {
    return JSON.parse(readFileSync(sessionPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Sanitize a scoped npm name for manifest filename lookup (TECH-108).
 * Examples: `@org/pkg` → `org-pkg`. Plain names pass through unchanged.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeServiceName(name) {
  return name.replace(/^@/, '').replace(/[/]/g, '-');
}

/**
 * Build a structured InfraBlockedEvidence-shaped payload mirroring Item A.
 *
 * @param {object} options
 * @returns {object}
 */
function buildEvidence({ narrative, dispatchId, sessionId, exceptionTrace = null }) {
  const evidence = {
    timestamp: new Date().toISOString(),
    narrative: typeof narrative === 'string' ? narrative : '<missing narrative>',
    dispatch_id: typeof dispatchId === 'string' ? dispatchId : '<missing>',
    session_id: typeof sessionId === 'string' ? sessionId : '<missing>',
  };
  if (exceptionTrace) {
    evidence.exception_trace = exceptionTrace;
  }
  return evidence;
}

/**
 * Run a consumer step via execFile with per-step timeout. Captures stdout/stderr.
 *
 * @param {object} args
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runConsumerStep({ command, args, cwd, timeoutMs }) {
  return new Promise((resolve_) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdoutBuf, stderrBuf) => {
        stdout = stdoutBuf?.toString() ?? '';
        stderr = stderrBuf?.toString() ?? '';
        if (err && err.killed) {
          timedOut = true;
        }
        resolve_({
          exitCode: err ? (err.code ?? 1) : 0,
          stdout,
          stderr,
          timedOut,
        });
      }
    );
    void child;
  });
}

/**
 * Finalize a SKIP outcome (no_manifest / no_service_name / no_routes_for_phase).
 * Emits gate_complete and returns the contract shape.
 */
async function finalizeSkip({ reason, narrative, recordAuditEvent, sessionPath, startMs }) {
  const cumulativeMs = Date.now() - startMs;
  const { audit_seq } = await recordAuditEvent({
    eventName: 'gate_complete',
    payload: {
      result: 'SKIP',
      sessionPath,
      reason,
      narrative,
      cumulative_ms: cumulativeMs,
    },
  });
  return { result: 'skipped', reason, evidence: null, audit_seq };
}

/**
 * Finalize a FAIL outcome where teardown was NOT (yet) run.
 */
async function finalizeFail({
  reason,
  narrative,
  recordAuditEvent,
  sessionPath,
  startMs,
  dispatchId,
  sessionId,
  exceptionTrace,
}) {
  const cumulativeMs = Date.now() - startMs;
  const evidence = buildEvidence({ narrative, dispatchId, sessionId, exceptionTrace });
  const { audit_seq } = await recordAuditEvent({
    eventName: 'gate_complete',
    payload: {
      result: 'FAIL',
      sessionPath,
      reason,
      narrative,
      cumulative_ms: cumulativeMs,
      evidence,
    },
  });
  return { result: 'failed', reason, evidence, audit_seq };
}

/**
 * Run pre-merge-teardown (when declared) and finalize a FAIL outcome.
 *
 * Per SEC-005 try/finally invariant: teardown ALWAYS runs even when steps
 * 1-4 failed. Teardown failure is ADVISORY (not a gate-blocking outcome
 * on top of the existing failure).
 */
async function runTeardownAndFinalize({
  reason,
  narrative,
  worktreeRoot,
  scripts,
  stepTimeoutMs,
  recordAuditEvent,
  sessionPath,
  startMs,
  dispatchId,
  sessionId,
  specGroupId,
}) {
  const hasTeardown = typeof scripts['pre-merge-teardown'] === 'string';
  if (hasTeardown) {
    await recordAuditEvent({
      eventName: 'teardown_start',
      payload: {
        result: null,
        sessionPath,
        phase: 'failure-cleanup',
      },
    });
    const teardownCheck = rejectShellMetacharacters(scripts['pre-merge-teardown']);
    let teardownFailed = false;
    if (teardownCheck.ok) {
      const teardownOutcome = await runConsumerStep({
        command: 'npm',
        args: ['run', 'pre-merge-teardown', '--ignore-scripts'],
        cwd: worktreeRoot,
        timeoutMs: stepTimeoutMs,
      });
      await recordAuditEvent({
        eventName: 'teardown_complete',
        payload: {
          result: teardownOutcome.exitCode === 0 ? 'PASS' : 'FAIL',
          sessionPath,
          exit_code: teardownOutcome.exitCode,
        },
      });
      if (teardownOutcome.exitCode !== 0) teardownFailed = true;
    } else {
      await recordAuditEvent({
        eventName: 'teardown_complete',
        payload: {
          result: 'FAIL',
          sessionPath,
          reason: 'teardown_failed',
          narrative: teardownCheck.narrative,
        },
      });
      teardownFailed = true;
    }
    // H1 code-review Pass 1 fix: teardown failure during failure-cleanup
    // path also sets the quarantine flag via the named export. The gate
    // is already going to record `result: 'failed'` for the upstream
    // reason; quarantining ensures the NEXT gate run halts at NFR-26 step
    // 3 until the operator acknowledges.
    if (teardownFailed) {
      await trySetQuarantineFlag(specGroupId, recordAuditEvent, sessionPath);
    }
  }
  return finalizeFail({
    reason,
    narrative,
    recordAuditEvent,
    sessionPath,
    startMs,
    dispatchId,
    sessionId,
  });
}

/**
 * Assemble the full five-step pipeline (boot → readiness → verify →
 * teardown). Setup is run by the caller (which short-circuits on setup
 * failure) so this function takes over from step 2.
 *
 * BUG-FIX-2026-05-09: previously a stub that emitted PASS audit entries
 * without doing the boot/readiness/verify work. The real implementation:
 *   - Runs the boot script under runConsumerStep (capturing stdout).
 *   - Parses the first JSON line {url, pid}.
 *   - Validates the URL via validatePreMergeUrl (NFR-15+SEC-101 allow-list:
 *     loopback, RFC1918, IPv6 unique-local, IPv6 link-local; rejects
 *     169.254/16 IPv4 link-local + AWS metadata IP).
 *   - Probes <bootUrl><readiness_path> via probeReadiness.
 *   - Iterates manifest routes filtered by phases.includes("pre-merge"),
 *     hits each route via fetch, evaluates status via evaluateProbeStatus.
 *   - Aggregates per-route results: any FAIL → health_check_failed.
 *   - Zero phase-matched routes → no_routes_for_phase advisory PASS.
 */
async function assembleAndRunPipeline({
  worktreeRoot,
  packageJson,
  scripts,
  hasTeardown,
  stepTimeoutMs,
  manifestResult,
  recordAuditEvent,
  sessionPath,
  startMs,
  dispatchId,
  sessionId,
  specGroupId,
}) {
  // The full pipeline is implemented as a sequence of audit-bracketed
  // steps. Each step short-circuits on failure and routes through the
  // teardown-and-finalize helper.

  // ---------- Step 2: Boot ----------------------------------------------
  // Boot validation (script value).
  const bootCheck = rejectShellMetacharacters(scripts['pre-merge-boot']);
  if (!bootCheck.ok) {
    return runTeardownAndFinalize({
      reason: 'boot_failed',
      narrative: bootCheck.narrative,
      worktreeRoot,
      scripts,
      stepTimeoutMs,
      recordAuditEvent,
      sessionPath,
      startMs,
      dispatchId,
      sessionId,
      specGroupId,
    });
  }

  await recordAuditEvent({
    eventName: 'boot_start',
    payload: {
      result: null,
      sessionPath,
      spec_group_id: specGroupId,
    },
  });

  const portAllowlist = Array.isArray(packageJson?.pre_merge_verify_port_allowlist)
    ? packageJson.pre_merge_verify_port_allowlist
    : [];

  // Run boot via execFile (synchronous wait for boot to print + exit).
  // For long-running production boots, the boot script is expected to
  // either: (a) emit URL/pid then exit (handing off to a daemon process
  // managed externally), or (b) be wrapped by the consumer so stdout closes
  // promptly after URL emission. Either pattern works with runConsumerStep.
  // Detached process-group spawn (spawnDetached) remains exposed for
  // consumers that need long-lived in-process boots; this assembly path
  // covers the documented test contract (DEC-007 real subprocess fixtures).
  const bootOutcome = await runConsumerStep({
    command: 'npm',
    args: ['run', 'pre-merge-boot', '--ignore-scripts'],
    cwd: worktreeRoot,
    timeoutMs: stepTimeoutMs,
  });

  if (bootOutcome.exitCode !== 0) {
    await recordAuditEvent({
      eventName: 'boot_complete',
      payload: {
        result: 'FAIL',
        sessionPath,
        exit_code: bootOutcome.exitCode,
        timed_out: bootOutcome.timedOut,
      },
    });
    return runTeardownAndFinalize({
      reason: bootOutcome.timedOut ? 'boot_failed_not_ready' : 'boot_failed',
      narrative:
        `pre-merge-boot exited ${bootOutcome.exitCode}: ${bootOutcome.stderr.slice(0, 500)}`,
      worktreeRoot,
      scripts,
      stepTimeoutMs,
      recordAuditEvent,
      sessionPath,
      startMs,
      dispatchId,
      sessionId,
      specGroupId,
    });
  }

  // Parse FIRST stdout JSON line matching {url, pid?}.
  const parseResult = parseBootStdoutForUrlAndPid(bootOutcome.stdout);
  if (!parseResult.ok) {
    await recordAuditEvent({
      eventName: 'boot_complete',
      payload: {
        result: 'FAIL',
        sessionPath,
        narrative: parseResult.narrative,
      },
    });
    return runTeardownAndFinalize({
      reason: 'boot_failed',
      narrative: parseResult.narrative,
      worktreeRoot,
      scripts,
      stepTimeoutMs,
      recordAuditEvent,
      sessionPath,
      startMs,
      dispatchId,
      sessionId,
      specGroupId,
    });
  }

  // Validate URL (SEC-101 / NFR-15 / DEC-005).
  const urlValidation = validatePreMergeUrl(parseResult.url, { portAllowlist });
  if (!urlValidation.valid) {
    await recordAuditEvent({
      eventName: 'boot_complete',
      payload: {
        result: 'FAIL',
        sessionPath,
        reason: urlValidation.reason,
        narrative: urlValidation.narrative,
      },
    });
    // NB: when boot script kept a process alive, killProcessGroup(parseResult.pid)
    // would fire here. The shell-script test fixtures (DEC-007) emit URL+exit,
    // so the leader is already gone — kill is a no-op (ESRCH → killed_clean).
    if (Number.isInteger(parseResult.pid) && parseResult.pid > 0) {
      try {
        await killProcessGroup(parseResult.pid);
      } catch {
        // Best effort; ESRCH is the common case for short-lived boot stubs.
      }
    }
    return runTeardownAndFinalize({
      reason: urlValidation.reason || 'boot_failed_url_invalid',
      narrative: urlValidation.narrative || 'URL validation failed',
      worktreeRoot,
      scripts,
      stepTimeoutMs,
      recordAuditEvent,
      sessionPath,
      startMs,
      dispatchId,
      sessionId,
      specGroupId,
    });
  }

  const bootUrl = parseResult.url;

  await recordAuditEvent({
    eventName: 'boot_complete',
    payload: {
      result: 'PASS',
      sessionPath,
      host_kind: urlValidation.hostKind,
    },
  });

  // ---------- Step 3: Readiness probe (DEC-010 single envelope) ----------
  const readinessPath =
    typeof packageJson?.pre_merge_readiness_path === 'string'
      ? packageJson.pre_merge_readiness_path
      : PRE_MERGE_DEFAULT_READINESS_PATH;
  const readinessUrl = `${bootUrl}${readinessPath}`;

  // sec-pmv-004 fix: re-validate the assembled readiness URL. Even though
  // bootUrl was validated above, the consumer-supplied
  // `pre_merge_readiness_path` could carry a `..//` segment, an embedded
  // `@` (userinfo smuggling via path), a host-overriding scheme, or other
  // shape that morphs the final probe target into a non-private URL.
  // Re-running validatePreMergeUrl on the concatenation closes that gap:
  // the resolved string must independently satisfy the same allow-list.
  const readinessUrlValidation = validatePreMergeUrl(readinessUrl, { portAllowlist });
  if (!readinessUrlValidation.valid) {
    await recordAuditEvent({
      eventName: 'readiness_start',
      payload: {
        result: 'FAIL',
        sessionPath,
        readiness_path: readinessPath,
        reason: 'boot_failed_url_invalid',
        narrative:
          readinessUrlValidation.narrative ||
          'assembled readiness URL failed re-validation',
      },
    });
    return runTeardownAndFinalize({
      reason: 'boot_failed_url_invalid',
      narrative:
        `assembled readiness URL ${readinessUrl} failed re-validation: ` +
        (readinessUrlValidation.narrative || 'no narrative'),
      worktreeRoot,
      scripts,
      stepTimeoutMs,
      recordAuditEvent,
      sessionPath,
      startMs,
      dispatchId,
      sessionId,
      specGroupId,
    });
  }

  await recordAuditEvent({
    eventName: 'readiness_start',
    payload: {
      result: null,
      sessionPath,
      readiness_path: readinessPath,
    },
  });

  const readinessResult = await probeReadiness(readinessUrl, stepTimeoutMs);
  if (!readinessResult.ready) {
    await recordAuditEvent({
      eventName: 'readiness_complete',
      payload: {
        result: 'FAIL',
        sessionPath,
        attempts: readinessResult.attempts,
        narrative: readinessResult.narrative,
      },
    });
    return runTeardownAndFinalize({
      reason: readinessResult.reason || 'boot_failed_not_ready',
      narrative:
        readinessResult.narrative || `readiness probe failed against ${readinessUrl}`,
      worktreeRoot,
      scripts,
      stepTimeoutMs,
      recordAuditEvent,
      sessionPath,
      startMs,
      dispatchId,
      sessionId,
      specGroupId,
    });
  }

  await recordAuditEvent({
    eventName: 'readiness_complete',
    payload: {
      result: 'PASS',
      sessionPath,
      attempts: readinessResult.attempts,
    },
  });

  // ---------- Step 4: Verify (manifest-driven per-route probes) ----------
  // BUG-FIX-2026-05-09 (Bug 1): replace runVerifyDeploy stub call (which only
  // handles single-endpoint smoke and never probed manifest routes) with a
  // direct per-route prober that filters by phases.includes("pre-merge"),
  // fetches each route at <bootUrl><route.path>, and aggregates status.
  await recordAuditEvent({
    eventName: 'verify_start',
    payload: {
      result: null,
      sessionPath,
      phase_filter: 'pre-merge',
    },
  });

  const manifest = manifestResult.data;
  const allRoutes = Array.isArray(manifest?.routes) ? manifest.routes : [];
  const phaseRoutes = allRoutes.filter(
    (r) => Array.isArray(r?.phases) && r.phases.includes('pre-merge')
  );

  // EC-13 / AC-14.3: zero phase-matched routes → no_routes_for_phase advisory.
  if (phaseRoutes.length === 0) {
    await recordAuditEvent({
      eventName: 'verify_complete',
      payload: {
        result: 'PASS',
        sessionPath,
        reason: 'no_routes_for_phase',
        routes_total: allRoutes.length,
        routes_matched: 0,
      },
    });
    if (hasTeardown) {
      await runTeardownStep({
        scripts,
        worktreeRoot,
        stepTimeoutMs,
        recordAuditEvent,
        sessionPath,
        specGroupId,
      });
    }
    const cumulativeMs = Date.now() - startMs;
    const { audit_seq } = await recordAuditEvent({
      eventName: 'gate_complete',
      payload: {
        result: 'PASS',
        sessionPath,
        reason: 'no_routes_for_phase',
        cumulative_ms: cumulativeMs,
      },
    });
    return { result: 'passed', reason: 'no_routes_for_phase', evidence: null, audit_seq };
  }

  // Probe each phase-matched route. Aggregate failures.
  const probeAggregate = await runRouteProbes({
    bootUrl,
    routes: phaseRoutes,
    perRouteTimeoutMs: stepTimeoutMs,
  });

  if (probeAggregate.failedCount > 0) {
    await recordAuditEvent({
      eventName: 'verify_complete',
      payload: {
        result: 'FAIL',
        sessionPath,
        routes_total: phaseRoutes.length,
        routes_failed: probeAggregate.failedCount,
        first_failure: probeAggregate.firstFailure,
      },
    });
    return runTeardownAndFinalize({
      reason: 'health_check_failed',
      narrative:
        `Pre-merge route probe failed for ${probeAggregate.failedCount}/${phaseRoutes.length} routes. ` +
        `First failure: ${probeAggregate.firstFailure?.method} ${probeAggregate.firstFailure?.path} → ` +
        `status=${probeAggregate.firstFailure?.status ?? '<error>'} ` +
        `(expected ${JSON.stringify(probeAggregate.firstFailure?.expected)}).` +
        ' Fixture-staleness is a possible cause; check fixture freshness before assuming code defect (EC-14).',
      worktreeRoot,
      scripts,
      stepTimeoutMs,
      recordAuditEvent,
      sessionPath,
      startMs,
      dispatchId,
      sessionId,
      specGroupId,
    });
  }

  await recordAuditEvent({
    eventName: 'verify_complete',
    payload: {
      result: 'PASS',
      sessionPath,
      routes_total: phaseRoutes.length,
      routes_passed: probeAggregate.passedCount,
    },
  });

  // ---------- Step 5: Teardown (try/finally invariant, SEC-005) ----------
  if (hasTeardown) {
    const teardownOutcome = await runTeardownStep({
      scripts,
      worktreeRoot,
      stepTimeoutMs,
      recordAuditEvent,
      sessionPath,
      specGroupId,
    });
    if (teardownOutcome.advisoryReason) {
      const cumulativeMs = Date.now() - startMs;
      const { audit_seq } = await recordAuditEvent({
        eventName: 'gate_complete',
        payload: {
          result: 'PASS',
          sessionPath,
          reason: teardownOutcome.advisoryReason,
          quarantine: true,
          cumulative_ms: cumulativeMs,
        },
      });
      // ADVISORY bucket: status === "passed", reason set, do NOT block.
      // Quarantine flag set by the dispatch layer.
      return {
        result: 'passed',
        reason: teardownOutcome.advisoryReason,
        evidence: null,
        audit_seq,
      };
    }
  } else {
    // EDGE-022: teardown not declared → emit teardown_skipped advisory.
    const cumulativeMs = Date.now() - startMs;
    const { audit_seq } = await recordAuditEvent({
      eventName: 'gate_complete',
      payload: {
        result: 'PASS',
        sessionPath,
        reason: 'teardown_skipped',
        cumulative_ms: cumulativeMs,
      },
    });
    return { result: 'passed', reason: 'teardown_skipped', evidence: null, audit_seq };
  }

  // Happy path: all five steps PASS.
  const cumulativeMs = Date.now() - startMs;
  const { audit_seq } = await recordAuditEvent({
    eventName: 'gate_complete',
    payload: {
      result: 'PASS',
      sessionPath,
      cumulative_ms: cumulativeMs,
    },
  });
  return { result: 'passed', reason: null, evidence: null, audit_seq };
}

/**
 * Parse the first JSON line in boot stdout that contains a `url` field.
 *
 * Boot scripts emit `{"url": "...", "pid": <int>}` per the AS-5 contract
 * (DEC-007). Lines before/after the JSON line are tolerated (consumers may
 * print logs around the URL emission). Returns the first match; subsequent
 * lines ignored.
 *
 * @param {string} stdout
 * @returns {{ ok: true, url: string, pid: number|null } | { ok: false, narrative: string }}
 */
function parseBootStdoutForUrlAndPid(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) {
    return {
      ok: false,
      narrative: 'pre-merge-boot produced no stdout (expected JSON line with url/pid)',
    };
  }
  const lines = stdout.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.charCodeAt(0) !== 0x7b /* '{' */) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof parsed.url === 'string' &&
      parsed.url.length > 0
    ) {
      const pid =
        typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null;
      return { ok: true, url: parsed.url, pid };
    }
  }
  return {
    ok: false,
    narrative:
      'pre-merge-boot stdout did not contain a JSON line with a string `url` field. ' +
      `First 500 chars: ${stdout.slice(0, 500)}`,
  };
}

/**
 * Probe each manifest-declared route at `<bootUrl><route.path>` and aggregate
 * pass/fail counts. Used by the verify step (REQ-005 / AC-5.3).
 *
 * Status evaluation mirrors `evaluateProbeStatus` from deployment-verify.mjs
 * (route-level `expected_status` overrides method defaults). The aggregator
 * fails on the FIRST route mismatch but completes all probes for diagnostic
 * coverage.
 *
 * @param {object} args
 * @param {string} args.bootUrl Base URL emitted by boot (validated upstream).
 * @param {object[]} args.routes Phase-filtered manifest routes.
 * @param {number} args.perRouteTimeoutMs Timeout cap per probe; capped to 5s
 *   to keep verify-step cumulative time bounded against many routes.
 * @returns {Promise<{ passedCount: number, failedCount: number, firstFailure: object | null, perRoute: object[] }>}
 */
async function runRouteProbes({ bootUrl, routes, perRouteTimeoutMs }) {
  const perRoute = [];
  let passedCount = 0;
  let failedCount = 0;
  let firstFailure = null;

  // Cap each route at the lesser of step timeout and 5s — the latter prevents
  // a single hung route from dominating step budget when many routes match.
  const capPerRoute = Math.min(
    Number.isFinite(perRouteTimeoutMs) ? perRouteTimeoutMs : 5_000,
    5_000
  );

  for (const route of routes) {
    const method =
      typeof route?.method === 'string' && route.method.length > 0 ? route.method : 'GET';
    const path =
      typeof route?.path === 'string' && route.path.length > 0 ? route.path : '/';
    const expected = Array.isArray(route?.expected_status) ? route.expected_status : null;
    const probeUrl = `${bootUrl}${path}`;

    let statusCode = null;
    let probeError = null;

    try {
      const headers = {
        'User-Agent': 'pre-merge-verify/1.0',
        ...(route?.headers && typeof route.headers === 'object' ? route.headers : {}),
      };
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        headers['Content-Type'] = 'application/json';
      }
      const fetchOptions = {
        method,
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(capPerRoute),
      };
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        fetchOptions.body = JSON.stringify(
          route?.body_skeleton && typeof route.body_skeleton === 'object'
            ? route.body_skeleton
            : {}
        );
      }
      const response = await fetch(probeUrl, fetchOptions);
      statusCode = response.status;
    } catch (err) {
      probeError = err?.message || String(err);
    }

    const probeResult = evaluateProbeStatus(method, statusCode, expected || undefined);
    const entry = {
      method,
      path,
      url: probeUrl,
      status: statusCode,
      expected,
      result: probeResult,
      error: probeError,
    };
    perRoute.push(entry);
    if (probeResult === 'PASS') {
      passedCount++;
    } else {
      failedCount++;
      if (firstFailure === null) firstFailure = entry;
    }
  }

  return { passedCount, failedCount, firstFailure, perRoute };
}

/**
 * Run the teardown step under audit bracketing. Returns advisoryReason
 * when teardown failed and (per H1 code-review Pass 1) sets the
 * quarantine flag in-process via `setPreMergeQuarantineFlag` so the next
 * gate run halts at NFR-26 step 3 until the operator acknowledges.
 *
 * Quarantine-set failure is logged but does not change the advisoryReason
 * (the gate result is already determined; the flag-write is best-effort
 * persistence). Setting the flag through the named export keeps the
 * sole-writer invariant (NFR-2): no direct session.json mutation here.
 */
async function runTeardownStep({
  scripts,
  worktreeRoot,
  stepTimeoutMs,
  recordAuditEvent,
  sessionPath,
  specGroupId,
}) {
  await recordAuditEvent({
    eventName: 'teardown_start',
    payload: {
      result: null,
      sessionPath,
    },
  });
  const teardownCheck = rejectShellMetacharacters(scripts['pre-merge-teardown']);
  if (!teardownCheck.ok) {
    await recordAuditEvent({
      eventName: 'teardown_complete',
      payload: {
        result: 'FAIL',
        sessionPath,
        reason: 'teardown_failed',
        narrative: teardownCheck.narrative,
      },
    });
    await trySetQuarantineFlag(specGroupId, recordAuditEvent, sessionPath);
    return { advisoryReason: 'teardown_failed' };
  }
  const outcome = await runConsumerStep({
    command: 'npm',
    args: ['run', 'pre-merge-teardown', '--ignore-scripts'],
    cwd: worktreeRoot,
    timeoutMs: stepTimeoutMs,
  });
  await recordAuditEvent({
    eventName: 'teardown_complete',
    payload: {
      result: outcome.exitCode === 0 ? 'PASS' : 'FAIL',
      sessionPath,
      exit_code: outcome.exitCode,
    },
  });
  if (outcome.exitCode !== 0) {
    await trySetQuarantineFlag(specGroupId, recordAuditEvent, sessionPath);
    return { advisoryReason: 'teardown_failed' };
  }
  return { advisoryReason: null };
}

/**
 * Best-effort wrapper around `setPreMergeQuarantineFlag` for the teardown
 * step. Per NFR-25 + H1 code-review Pass 1: any teardown failure should
 * leave the gate quarantined, but a write failure on the flag must not
 * mask the prior teardown failure or throw out of the orchestrator. We
 * record both outcomes in the audit chain so an operator inspecting the
 * trail can see whether the flag was actually written.
 */
async function trySetQuarantineFlag(specGroupId, recordAuditEvent, sessionPath) {
  if (!specGroupId || typeof specGroupId !== 'string') {
    // Defensive: caller forgot to pass it. Audit and bail without throwing.
    await recordAuditEvent({
      eventName: 'pre_merge_verify_quarantine_set_skipped',
      payload: {
        result: 'FAIL',
        sessionPath,
        narrative: 'specGroupId missing; quarantine flag not set',
      },
    });
    return;
  }
  try {
    const setQuarantine = await getSetPreMergeQuarantineFlag();
    setQuarantine(specGroupId, true);
    await recordAuditEvent({
      eventName: 'pre_merge_verify_quarantine_set',
      payload: {
        result: 'PASS',
        sessionPath,
        spec_group_id: specGroupId,
        narrative: 'quarantine_until_acknowledged set after teardown failure (NFR-25/AC-9.5)',
      },
    });
  } catch (err) {
    // Flag-write failure is logged but non-fatal. The teardown failure
    // is already the dominant outcome; surface this for diagnostics.
    process.stderr.write(
      `[pre-merge-verify] WARNING: setPreMergeQuarantineFlag failed: ${err.message}\n`
    );
    await recordAuditEvent({
      eventName: 'pre_merge_verify_quarantine_set_failed',
      payload: {
        result: 'FAIL',
        sessionPath,
        spec_group_id: specGroupId,
        narrative: `setPreMergeQuarantineFlag threw: ${err.message}`,
      },
    });
  }
}
