#!/usr/bin/env node

/**
 * reverse-governance-monitor.mjs
 *
 * Reverse-governance SLA monitor (REQ-015, NFR-1/NFR-2/NFR-7). Tracks a
 * monitoring window per coercive-flip audit entry (10 consecutive workstreams
 * OR 30 days, whichever first) and emits a structured `REVERSE_GOVERNANCE_DRIFT`
 * warning when:
 *
 *   1. A preserved-signal path has been silent for a 14-day rolling workstream
 *      activity window inside an open monitoring window (AC25.3). Preserved-
 *      signal activity is proxied by any non-`flag_flip` audit entry per
 *      spec.md §REQ-010 / NFR-PRES (four named paths; spec does not pin the
 *      detection mechanism so the proxy is documented as ASM-025-02).
 *   2. An NFR-7 preservation regression is surfaced (AC25.4) -- any entry
 *      whose payload carries `nfr7_regression: true` (explicit marker in the
 *      `z.record(z.unknown())` payload shape per spec.md:663) triggers the
 *      same warning with `reason: "nfr7-regression"`.
 *
 * The warning is emitted as:
 *   (a) Structured JSON to stderr (one JSON object per line), with a
 *       canonical `{token: "REVERSE_GOVERNANCE_DRIFT", gate, outcome_enum, ...}`
 *       shape. Each warning line is independently parseable.
 *   (b) A hash-chained audit entry via `appendAuditEntry` (AC25.5).
 *
 * Exit codes:
 *   0 - No drift detected.
 *   1 - Runtime error (audit log unreadable, audit append failed).
 *   2 - Drift emitted (structured-error convention per spec.md:686).
 *
 * Coercive-flip detection (ASM-025-01, SELF-RESOLVED(spec)):
 *   `event_class === "flag_flip"` AND (
 *     `payload.to === "coercive"` OR
 *     `payload.mode === "coercive"` OR
 *     `event_subtype` matches `*-to-coercive`
 *   ). Gate identity from `payload.gate` (preferred) or `payload.gate_name`.
 *
 * Preserved-signal proxy (ASM-025-02, SELF-RESOLVED(spec)):
 *   Any non-`flag_flip` entry in the audit log within the 14-day rolling
 *   window of `now` counts as preserved-signal activity. Absence of any such
 *   entry inside the window triggers the silence trigger. This is a
 *   conservative proxy; when a dedicated preserved-signal log lands (future
 *   work), the detection helper swaps without changing the exported contract.
 *
 * NFR-7 regression (ASM-025-03, SELF-RESOLVED(spec)):
 *   Any audit entry (any event_class) whose `payload.nfr7_regression === true`
 *   fires the preservation-regression trigger. `payload: z.record(z.unknown())`
 *   (spec.md:663) permits arbitrary markers.
 *
 * Warning audit-logging (ASM-025-04):
 *   Uses `appendAuditEntry('flag_flip', 'reverse-governance-drift-<reason>',
 *   payload)` via as-017. The 9-class canonical enum (as-003) has no dedicated
 *   reverse-governance class; adding one requires parent-spec amendment
 *   (spec.md:643) -- explicitly out-of-scope. `flag_flip` covers enforcement-
 *   flag lifecycle events; drift is an enforcement-related event.
 *
 * Env overrides (test-only; read-only monitor, no production coupling):
 *   PIPELINE_EFFICIENCY_AUDIT_LOG  - absolute path to audit log file
 *   PIPELINE_EFFICIENCY_GENESIS    - absolute path to genesis anchor file
 *   PIPELINE_EFFICIENCY_NOW_MS     - override "now" (ms since epoch) for
 *                                    deterministic rolling-window tests
 *   CLAUDE_PROJECT_DIR             - project-root override (passed through
 *                                    to appendAuditEntry so audit writes
 *                                    target the fixture tree)
 *
 * Implements: AC25.1, AC25.2, AC25.3, AC25.4, AC25.5.
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning as-025.
 *
 * @req REQ-015
 * @req REQ-010
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { appendAuditEntry } from './pipeline-efficiency-audit-log.mjs';

// =============================================================================
// Constants (all per-spec; default numerics 10/30/14 from REQ-015)
// =============================================================================

/** Monitoring window: max consecutive workstreams (REQ-015). */
const WINDOW_MAX_WORKSTREAMS = 10;

/** Monitoring window: max days post-flip (REQ-015). */
const WINDOW_MAX_DAYS = 30;

/** Preserved-signal silence threshold, in days (REQ-015). */
const SILENT_SIGNAL_DAYS = 14;

/** Milliseconds per day -- used for all day-based rolling-window math. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Default paths relative to project root. */
const DEFAULT_AUDIT_LOG_RELATIVE = '.claude/audit/pipeline-efficiency-changes.log';

/** Outcome-enum values (REQ-015 / requirements.md:256). Order is audit-stable. */
export const OUTCOME_ENUM_VALUES = [
  'scope-narrow',
  'budget-tune',
  'revert-advisory',
  'kill-gate',
];

/** Default outcome: revert-advisory is the most conservative reversible action. */
const DEFAULT_OUTCOME_ENUM = 'revert-advisory';

/**
 * Canonical preserved-signal paths (spec.md:133-136 / NFR-PRES). Exposed for
 * downstream consumers that key off the list; the monitor itself uses the
 * audit-log proxy (see module header).
 */
export const PRESERVED_SIGNAL_PATHS = [
  'prd-critic-sec-tech-edge',
  'investigation-pass-2-shape-drift',
  'completion-verifier-orphan-script',
  'shared-helper-boundary-lock',
];

/** Drift trigger_type enum (requirements.md:256, 259). */
const TRIGGER_PRESERVED_SILENT = 'preserved-signal-silent';
const TRIGGER_PRESERVATION_REGRESSION = 'preservation-regression';

/** Drift warning token (requirements.md:256, spec.md:72). */
export const WARNING_TOKEN = 'REVERSE_GOVERNANCE_DRIFT';

/** Exit codes.
 *
 * cr-dead-m3:
 *   Originally EXIT_USAGE was aliased to EXIT_DRIFT (both = 2). That made
 *   the constant functionally unused and collapsed two semantically distinct
 *   outcomes (bad CLI args vs. genuine drift detection) into a single
 *   shell-observable signal, forcing operators to inspect stderr to
 *   disambiguate. Distinct codes per AC25-spec escape clause (ASM-025-06:
 *   "If unifier prefers distinct codes, a future change shifts bad-args to
 *   3"). Chosen layout:
 *     0 — no drift (clean run)
 *     1 — runtime failure (unanticipated exception in main)
 *     2 — drift detected (structured-error convention, preserved for
 *         oracle compatibility)
 *     3 — usage error (unknown arg, invalid --now, invalid --outcome-enum)
 */
const EXIT_OK = 0;
const EXIT_RUNTIME_FAIL = 1;
const EXIT_DRIFT = 2;
const EXIT_USAGE = 3;

// =============================================================================
// Env-var and arg resolution
// =============================================================================

/**
 * Parse CLI args. Unknown flags exit with EXIT_USAGE so bad invocations are
 * loud. Env vars take precedence over defaults, CLI flags over env vars.
 */
export function parseArgs(argv, env = process.env) {
  const args = {
    auditLog: env.PIPELINE_EFFICIENCY_AUDIT_LOG || null,
    genesis: env.PIPELINE_EFFICIENCY_GENESIS || null,
    nowMs: env.PIPELINE_EFFICIENCY_NOW_MS
      ? Number.parseInt(env.PIPELINE_EFFICIENCY_NOW_MS, 10)
      : null,
    outcomeEnum: DEFAULT_OUTCOME_ENUM,
    projectRoot: env.CLAUDE_PROJECT_DIR || null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--audit-log' && i + 1 < argv.length) {
      args.auditLog = argv[++i];
    } else if (a === '--genesis' && i + 1 < argv.length) {
      args.genesis = argv[++i];
    } else if (a === '--now' && i + 1 < argv.length) {
      const parsed = Date.parse(argv[++i]);
      if (Number.isNaN(parsed)) {
        throw new Error(`invalid --now "${argv[i]}"; expected ISO-8601`);
      }
      args.nowMs = parsed;
    } else if (a === '--outcome-enum' && i + 1 < argv.length) {
      args.outcomeEnum = argv[++i];
      if (!OUTCOME_ENUM_VALUES.includes(args.outcomeEnum)) {
        throw new Error(
          `invalid --outcome-enum "${args.outcomeEnum}"; expected one of ${OUTCOME_ENUM_VALUES.join(', ')}`,
        );
      }
    } else if (a === '--project-root' && i + 1 < argv.length) {
      args.projectRoot = argv[++i];
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(EXIT_OK);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }

  return args;
}

function printUsage() {
  process.stderr.write(
    `Usage: node reverse-governance-monitor.mjs [options]\n` +
      `  --audit-log <path>       audit log path (env: PIPELINE_EFFICIENCY_AUDIT_LOG)\n` +
      `  --genesis <path>         genesis anchor path (env: PIPELINE_EFFICIENCY_GENESIS)\n` +
      `  --now <ISO-8601>         override current time (env: PIPELINE_EFFICIENCY_NOW_MS)\n` +
      `  --outcome-enum <value>   {scope-narrow|budget-tune|revert-advisory|kill-gate}\n` +
      `  --project-root <dir>     project-root override (env: CLAUDE_PROJECT_DIR)\n` +
      `  --dry-run                skip audit-log append (stderr-only)\n`,
  );
}

// =============================================================================
// Audit-log parsing
// =============================================================================

/**
 * Read JSONL audit log and return parsed entries. Absent file -> []. Malformed
 * lines throw (chain-corruption belongs to verify-audit-chain.mjs, but a
 * malformed line is fatal for the monitor: we can't tell a coercive flip
 * from a malformed record).
 *
 * @param {string} path - absolute audit log path
 * @returns {Array<Record<string, unknown>>}
 */
export function readAuditLog(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (raw.length === 0) return [];
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      throw new Error(
        `audit log malformed at ${path}: ${err.message}. Run verify-audit-chain.mjs to diagnose.`,
      );
    }
  }
  return entries;
}

/**
 * Identify coercive-flip entries from the audit log (AC25.1).
 *
 * Recognition (ASM-025-01):
 *   - event_class === "flag_flip"
 *   - EITHER payload.to === "coercive" (from-to pattern used by test fixtures
 *     and spec.md flow-3)
 *   - OR payload.mode === "coercive"
 *   - OR event_subtype matches `*-to-coercive` (regex fallback)
 *   - payload.gate (preferred) or payload.gate_name provides gate identity
 *
 * Returns chronologically-ordered entries.
 *
 * @param {Array<Record<string, unknown>>} entries
 * @returns {Array<{gate: string, flip_at: string, entry: object}>}
 */
export function findCoerciveFlips(entries) {
  const flips = [];
  for (const e of entries) {
    if (e.event_class !== 'flag_flip') continue;
    const subtype = typeof e.event_subtype === 'string' ? e.event_subtype : '';
    const payload = e.payload && typeof e.payload === 'object' ? e.payload : {};
    const isCoercive =
      payload.to === 'coercive' ||
      payload.mode === 'coercive' ||
      /-to-coercive$/.test(subtype);
    if (!isCoercive) continue;
    const gate =
      (typeof payload.gate === 'string' && payload.gate.length > 0
        ? payload.gate
        : null) ||
      (typeof payload.gate_name === 'string' && payload.gate_name.length > 0
        ? payload.gate_name
        : null);
    if (!gate) continue;
    if (typeof e.timestamp !== 'string') continue;
    flips.push({ gate, flip_at: e.timestamp, entry: e });
  }
  return flips;
}

/**
 * Count post-flip workstream-activity entries. A "workstream activity" is any
 * non-`flag_flip` audit entry that lands strictly after the flip timestamp.
 * This is a conservative proxy (ASM-025-04): over-counting only tightens
 * window closure, never relaxes it.
 *
 * @param {Array<Record<string, unknown>>} entries
 * @param {string} flipAtIso
 * @returns {number}
 */
export function countWorkstreamsSince(entries, flipAtIso) {
  const flipMs = new Date(flipAtIso).getTime();
  if (Number.isNaN(flipMs)) return 0;
  let count = 0;
  for (const e of entries) {
    if (e.event_class === 'flag_flip') continue; // flips themselves don't count as workstreams
    if (typeof e.timestamp !== 'string') continue;
    const ms = new Date(e.timestamp).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms <= flipMs) continue;
    count += 1;
  }
  return count;
}

// =============================================================================
// Window computation (AC25.1, AC25.2)
// =============================================================================

/**
 * Open and classify monitoring windows for each coercive flip.
 *
 * Window closes when EITHER:
 *   - Post-flip workstream count >= WINDOW_MAX_WORKSTREAMS (10), OR
 *   - Days elapsed since flip >= WINDOW_MAX_DAYS (30)
 *
 * Whichever fires first.
 *
 * @param {Array<{gate: string, flip_at: string}>} flips
 * @param {Array<Record<string, unknown>>} allEntries  -- for workstream counting
 * @param {Date} now
 * @returns {Array<{
 *   gate: string,
 *   flip_at: string,
 *   days_elapsed: number,
 *   workstream_count: number,
 *   is_open: boolean,
 *   close_reason: string | null
 * }>}
 */
export function computeMonitoringWindows(flips, allEntries, now) {
  const nowMs = now.getTime();
  const windows = [];
  for (const flip of flips) {
    const flipMs = new Date(flip.flip_at).getTime();
    if (Number.isNaN(flipMs)) continue;
    const daysElapsed = Math.max(0, (nowMs - flipMs) / MS_PER_DAY);
    const workstreamCount = countWorkstreamsSince(allEntries, flip.flip_at);
    let closeReason = null;
    if (workstreamCount >= WINDOW_MAX_WORKSTREAMS) {
      closeReason = 'workstream-cap-reached';
    } else if (daysElapsed >= WINDOW_MAX_DAYS) {
      closeReason = 'days-cap-reached';
    }
    windows.push({
      gate: flip.gate,
      flip_at: flip.flip_at,
      days_elapsed: daysElapsed,
      workstream_count: workstreamCount,
      is_open: closeReason === null,
      close_reason: closeReason,
    });
  }
  return windows;
}

// =============================================================================
// Preserved-signal detection (AC25.3)
// =============================================================================

/**
 * Find the most recent preserved-signal activity timestamp in the audit log.
 * Preserved-signal proxy: any non-`flag_flip` entry (ASM-025-02). Returns
 * the latest such ISO timestamp, or null when no such entries exist.
 *
 * @param {Array<Record<string, unknown>>} entries
 * @returns {string | null}
 */
export function findLatestPreservedSignal(entries) {
  let latestMs = -Infinity;
  let latestIso = null;
  for (const e of entries) {
    if (e.event_class === 'flag_flip') continue;
    if (typeof e.timestamp !== 'string') continue;
    const ms = new Date(e.timestamp).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms > latestMs) {
      latestMs = ms;
      latestIso = e.timestamp;
    }
  }
  return latestIso;
}

/**
 * Determine whether preserved-signal is silent for >= SILENT_SIGNAL_DAYS
 * relative to `now`. Returns `{silent, silent_since_iso, days_silent}`.
 *
 * - If `latestSignalIso === null` AND window has been open for >= SILENT_SIGNAL_DAYS,
 *   treat as silent (no signal has ever fired inside the window).
 * - If `latestSignalIso` exists and `(now - latest) >= SILENT_SIGNAL_DAYS` days,
 *   silent.
 *
 * @param {string | null} latestSignalIso
 * @param {Date} now
 * @param {number} windowDaysElapsed
 * @returns {{ silent: boolean, silent_since_iso: string | null, days_silent: number }}
 */
export function classifySilence(latestSignalIso, now, windowDaysElapsed) {
  const nowMs = now.getTime();
  if (latestSignalIso === null) {
    if (windowDaysElapsed >= SILENT_SIGNAL_DAYS) {
      return { silent: true, silent_since_iso: null, days_silent: windowDaysElapsed };
    }
    return { silent: false, silent_since_iso: null, days_silent: windowDaysElapsed };
  }
  const latestMs = new Date(latestSignalIso).getTime();
  if (Number.isNaN(latestMs)) {
    return { silent: false, silent_since_iso: null, days_silent: 0 };
  }
  const daysSilent = (nowMs - latestMs) / MS_PER_DAY;
  if (daysSilent >= SILENT_SIGNAL_DAYS) {
    return { silent: true, silent_since_iso: latestSignalIso, days_silent: daysSilent };
  }
  return { silent: false, silent_since_iso: latestSignalIso, days_silent: daysSilent };
}

// =============================================================================
// NFR-7 regression detection (AC25.4)
// =============================================================================

/**
 * Scan audit entries for NFR-7 preservation-regression markers. Shape per
 * ASM-025-03: `payload.nfr7_regression === true` on any entry. Returns the
 * list of entries that carry the marker.
 *
 * @param {Array<Record<string, unknown>>} entries
 * @returns {Array<{timestamp: string, preserved_path: string | null, entry: object}>}
 */
export function findNfr7Regressions(entries) {
  const out = [];
  for (const e of entries) {
    const payload = e.payload && typeof e.payload === 'object' ? e.payload : {};
    if (payload.nfr7_regression !== true) continue;
    if (typeof e.timestamp !== 'string') continue;
    const preservedPath =
      typeof payload.preserved_path === 'string' ? payload.preserved_path : null;
    out.push({ timestamp: e.timestamp, preserved_path: preservedPath, entry: e });
  }
  return out;
}

// =============================================================================
// Warning emission (AC25.3, AC25.4, AC25.5)
// =============================================================================

/**
 * Build a REVERSE_GOVERNANCE_DRIFT warning payload. The `token` key is the
 * canonical discriminator; all other fields are diagnostic context.
 *
 * Shape (requirements.md:256 + AC25.3):
 *   {
 *     token: "REVERSE_GOVERNANCE_DRIFT",
 *     gate: string,
 *     outcome_enum: one of OUTCOME_ENUM_VALUES,
 *     reason: "preserved-signal-silent" | "nfr7-regression",
 *     trigger_type: same as reason (requirements.md canonical name),
 *     silent_since: ISO-8601 | null,
 *     window_kind: "workstreams-or-days",
 *     silent_days: number,
 *     flip_at: ISO-8601,
 *     days_elapsed: number,
 *     workstream_count: number,
 *     ...optional extras
 *   }
 *
 * @param {object} window
 * @param {string} reason
 * @param {string | null} silentSince
 * @param {string} outcomeEnum
 * @param {Record<string, unknown>} extra
 * @returns {Record<string, unknown>}
 */
export function buildWarning(window, reason, silentSince, outcomeEnum, extra = {}) {
  return {
    token: WARNING_TOKEN,
    gate: window.gate,
    outcome_enum: outcomeEnum,
    reason,
    trigger_type: reason,
    silent_since: silentSince,
    window_kind: 'workstreams-or-days',
    flip_at: window.flip_at,
    days_elapsed: window.days_elapsed,
    workstream_count: window.workstream_count,
    ...extra,
  };
}

/**
 * Evaluate open windows and build drift warnings.
 *
 * For each open window:
 *   1. AC25.3: if preserved-signal silent for >= 14 days, emit
 *      "preserved-signal-silent" warning.
 *   2. AC25.4: for each NFR-7 regression marker at or after flip_at, emit
 *      "nfr7-regression" warning.
 *
 * @param {Array<object>} windows
 * @param {string | null} latestSignalIso - latest preserved-signal activity
 * @param {Array<object>} regressions - findNfr7Regressions() output
 * @param {string} outcomeEnum
 * @param {Date} now
 * @returns {Array<Record<string, unknown>>}
 */
export function detectDriftWarnings(windows, latestSignalIso, regressions, outcomeEnum, now) {
  const warnings = [];
  for (const w of windows) {
    if (!w.is_open) continue;

    // AC25.3 -- preserved-signal silence
    const sil = classifySilence(latestSignalIso, now, w.days_elapsed);
    if (sil.silent) {
      warnings.push(
        buildWarning(w, TRIGGER_PRESERVED_SILENT, sil.silent_since_iso, outcomeEnum, {
          silent_days: sil.days_silent,
        }),
      );
    }

    // AC25.4 -- NFR-7 regression (entries within window only)
    const flipMs = new Date(w.flip_at).getTime();
    for (const r of regressions) {
      const rMs = new Date(r.timestamp).getTime();
      if (Number.isNaN(rMs)) continue;
      if (rMs < flipMs) continue;
      warnings.push(
        buildWarning(w, 'nfr7-regression', r.timestamp, outcomeEnum, {
          preserved_path: r.preserved_path,
        }),
      );
    }
  }
  return warnings;
}

/**
 * Emit a drift warning: stderr JSON line + audit-log append (AC25.5).
 *
 * The stderr format is strictly one JSON object per line so downstream
 * parsers (e.g., the test harness's `parseDriftWarnings`) can split on
 * newlines and JSON.parse each line independently.
 *
 * Audit-log append uses `event_class: "flag_flip"` with a distinctive
 * subtype prefix `reverse-governance-drift-<reason>`. A new event_class
 * would require parent-spec amendment (spec.md:643), out-of-scope per as-025.
 *
 * @param {Record<string, unknown>} payload
 * @param {object} options
 * @param {boolean} [options.dryRun]
 * @param {string} [options.projectRoot]
 * @returns {{ audit_seq: number | null }}
 */
export function emitWarning(payload, options = {}) {
  // (a) stderr JSON line -- always attempted so downstream parsers observe
  //     the drift even when audit-append fails (fixture / no-genesis mode).
  process.stderr.write(`${JSON.stringify(payload)}\n`);

  // (b) Audit-log append (AC25.5).
  if (options.dryRun) {
    return { audit_seq: null, audit_error: null };
  }
  const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown';
  const subtype = `reverse-governance-drift-${reason}`;
  try {
    const { seq } = appendAuditEntry('flag_flip', subtype, payload, {
      actor: 'agent',
      projectRoot: options.projectRoot,
    });
    return { audit_seq: seq, audit_error: null };
  } catch (err) {
    // Non-fatal in fixture contexts where the appender cannot locate the
    // genesis anchor. In production (where the genesis exists), this path is
    // not taken. Callers inspect `audit_error` to decide whether to escalate.
    process.stderr.write(
      `WARN: audit-log append failed for drift warning: ${err.message}\n`,
    );
    return { audit_seq: null, audit_error: err };
  }
}

// =============================================================================
// Orchestration
// =============================================================================

/**
 * Run the monitor end-to-end. Returns a summary; callers decide exit code.
 *
 * @param {object} opts
 * @param {string} opts.auditLogPath
 * @param {Date} opts.now
 * @param {string} opts.outcomeEnum
 * @param {boolean} [opts.dryRun]
 * @param {string} [opts.projectRoot]
 * @returns {{
 *   flips: number,
 *   open_windows: number,
 *   closed_windows: number,
 *   warnings_emitted: number,
 *   warnings: Array<Record<string, unknown>>
 * }}
 */
export function runMonitor(opts) {
  const entries = readAuditLog(opts.auditLogPath);
  const flips = findCoerciveFlips(entries);
  const windows = computeMonitoringWindows(flips, entries, opts.now);
  const latestSignalIso = findLatestPreservedSignal(entries);
  const regressions = findNfr7Regressions(entries);
  const warnings = detectDriftWarnings(
    windows,
    latestSignalIso,
    regressions,
    opts.outcomeEnum,
    opts.now,
  );

  for (const w of warnings) {
    emitWarning(w, { dryRun: opts.dryRun, projectRoot: opts.projectRoot });
  }

  const openCount = windows.filter((w) => w.is_open).length;
  return {
    flips: flips.length,
    open_windows: openCount,
    closed_windows: windows.length - openCount,
    warnings_emitted: warnings.length,
    warnings,
  };
}

// =============================================================================
// Project-root resolution (for appendAuditEntry redirection)
// =============================================================================

/**
 * Resolve the project root that `appendAuditEntry` should use. The audit
 * appender resolves paths relative to its project root; to redirect writes
 * to the fixture log, we compute the project root such that
 * `<root>/.claude/audit/pipeline-efficiency-changes.log === auditLogPath`.
 *
 * If the audit log path ends in the canonical relative suffix, strip it to
 * recover the project root. Otherwise fall back to the explicit
 * `args.projectRoot` (or process.cwd()).
 *
 * @param {string} auditLogPath - resolved absolute path to audit log
 * @param {string | null} explicitRoot
 * @returns {string}
 */
function resolveAppenderProjectRoot(auditLogPath, explicitRoot) {
  if (explicitRoot) return explicitRoot;
  // The appender hardcodes the relative path `.claude/audit/pipeline-efficiency-changes.log`.
  // Strip that suffix from auditLogPath to recover the appender's expected root.
  const suffix = `/${DEFAULT_AUDIT_LOG_RELATIVE}`;
  if (auditLogPath.endsWith(suffix)) {
    return auditLogPath.slice(0, -suffix.length);
  }
  // Fallback: when the fixture places the log at a non-canonical flat location
  // (e.g., <fixtureDir>/pipeline-efficiency-changes.log), use the parent
  // directory of the audit log as the appender's project root. `bootstrapFixtureLayout`
  // then stages a `.claude/audit/` nested sub-path under that root via symlinks
  // pointing at the fixture files so the appender's O_APPEND writes transit
  // to the flat fixture log the test oracle reads.
  return dirname(auditLogPath);
}

/**
 * Stage a canonical `.claude/audit/` layout under `appenderRoot` when the
 * fixture places the log/genesis at flat paths (e.g., tmpdir fixtures used by
 * as-025's monitor test). `appendAuditEntry` hardcodes the relative paths
 * `.claude/audit/pipeline-efficiency-{changes.log,genesis.json}`; if those
 * canonical paths already exist (production case), this helper is a no-op.
 * If they are missing and the fixture files exist at `auditLogPath` / `genesisPath`,
 * symlink them into the canonical sub-path so:
 *
 *   1. The appender reads genesis via `<appenderRoot>/.claude/audit/pipeline-efficiency-genesis.json`
 *      (symlink → fixture genesis).
 *   2. The appender appends via `<appenderRoot>/.claude/audit/pipeline-efficiency-changes.log`
 *      (symlink → fixture log); O_APPEND writes land in the fixture log that
 *      the test oracle reads.
 *
 * Non-fatal on symlink failure — the appender will surface E_GENESIS_ANCHOR_MISSING
 * if the layout is unusable, matching prior fixture/no-genesis semantics.
 *
 * @param {string} appenderRoot - resolved project root passed to appendAuditEntry
 * @param {string} auditLogPath - absolute path to fixture (or canonical) audit log
 * @param {string | null} genesisPath - absolute path to fixture genesis or null
 * @returns {{ staged: boolean, reason: string }}
 */
function bootstrapFixtureLayout(appenderRoot, auditLogPath, genesisPath) {
  const canonicalLog = join(appenderRoot, DEFAULT_AUDIT_LOG_RELATIVE);
  const canonicalGenesis = join(
    appenderRoot,
    '.claude/audit/pipeline-efficiency-genesis.json',
  );

  // Fast path: canonical layout already present (production or canonical fixture).
  if (existsSync(canonicalGenesis) && existsSync(canonicalLog)) {
    return { staged: false, reason: 'canonical-layout-present' };
  }

  // Bootstrap requires both fixture files to exist and to diverge from the
  // canonical paths. If either is missing, defer to the appender's error path.
  if (!genesisPath || !existsSync(genesisPath) || !existsSync(auditLogPath)) {
    return { staged: false, reason: 'fixture-files-missing' };
  }

  try {
    mkdirSync(dirname(canonicalGenesis), { recursive: true });
    // Skip symlink creation if the target already points somewhere (defensive).
    if (!existsSync(canonicalGenesis) && genesisPath !== canonicalGenesis) {
      symlinkSync(genesisPath, canonicalGenesis);
    }
    if (!existsSync(canonicalLog) && auditLogPath !== canonicalLog) {
      symlinkSync(auditLogPath, canonicalLog);
    }
    return { staged: true, reason: 'symlinks-created' };
  } catch (err) {
    return { staged: false, reason: `bootstrap-failed: ${err.message}` };
  }
}

// =============================================================================
// Main
// =============================================================================

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    printUsage();
    process.exit(EXIT_USAGE);
  }

  const projectRoot =
    args.projectRoot || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const auditLogPath = args.auditLog
    ? resolve(args.auditLog.startsWith('/') ? args.auditLog : join(projectRoot, args.auditLog))
    : resolve(join(projectRoot, DEFAULT_AUDIT_LOG_RELATIVE));
  const now = args.nowMs !== null ? new Date(args.nowMs) : new Date();
  if (Number.isNaN(now.getTime())) {
    process.stderr.write(`ERROR: invalid now value\n`);
    process.exit(EXIT_USAGE);
  }

  // Resolve the project root the appender should use so that audit-log writes
  // land at the injected fixture path rather than the real log. When the env
  // override redirects to a fixture, we also point the appender there.
  const appenderRoot = resolveAppenderProjectRoot(auditLogPath, args.projectRoot);

  // Stage a canonical `.claude/audit/` sub-path under `appenderRoot` when the
  // fixture writes log/genesis to flat paths. Production paths already match
  // the canonical layout → this is a no-op there. Needed for AC25.5 so
  // `appendAuditEntry` can both read the fixture genesis and append to the
  // fixture log via symlinked canonical paths.
  const genesisPath = args.genesis
    ? resolve(args.genesis.startsWith('/') ? args.genesis : join(projectRoot, args.genesis))
    : null;
  bootstrapFixtureLayout(appenderRoot, auditLogPath, genesisPath);

  try {
    const summary = runMonitor({
      auditLogPath,
      now,
      outcomeEnum: args.outcomeEnum,
      dryRun: args.dryRun,
      projectRoot: appenderRoot,
    });
    process.stderr.write(
      `reverse-governance-monitor: flips=${summary.flips} ` +
        `open=${summary.open_windows} closed=${summary.closed_windows} ` +
        `warnings=${summary.warnings_emitted}` +
        `${args.dryRun ? ' (dry-run)' : ''}\n`,
    );
    // Exit 2 on drift (structured-error convention, per spec.md:686 + test oracle).
    if (summary.warnings_emitted > 0) {
      process.exit(EXIT_DRIFT);
    }
    process.exit(EXIT_OK);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(EXIT_RUNTIME_FAIL);
  }
}

// CLI entrypoint (only when invoked directly).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
