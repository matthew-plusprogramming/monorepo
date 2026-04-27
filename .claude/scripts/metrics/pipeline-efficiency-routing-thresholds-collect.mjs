#!/usr/bin/env node

/**
 * pipeline-efficiency-routing-thresholds-collect.mjs
 *
 * Baseline instrumentation for the routing-threshold heuristic.
 *
 * Reads recent `/route` decisions from `session.json.active_work.route_decisions[]`
 * (per .claude/docs/ROUTING.md)
 * and emits a JSON baseline artifact to stdout. The artifact captures the
 * pre-change routing distribution so post-change impact is measurable.
 *
 * T0 edge case: when the `route_decisions[]` append-only log is new, the
 * first run can be empty. That is expected; the artifact emits
 * `sample_size: 0` with a `bootstrap_note` explaining the T0 condition, and
 * exits 0 (NOT a failure). Post-ship decisions populate the log and future
 * runs reflect real distribution.
 *
 * Capture shape:
 *   {
 *     workstream_id: "sg-pipeline-efficiency-routing-thresholds",
 *     run_id: <iso-or-override>,
 *     published_at: <iso>,
 *     sample_size: <N>,
 *     sample_set_description: <string>,
 *     bootstrap_note?: <string>,             // present only when sample_size === 0
 *     decisions: Array<{
 *       timestamp: string,
 *       workflow: string,
 *       rationale_excerpt: string,
 *       multi_domain_justification: Array<{criterion, evidence}> | null
 *     }>,
 *     distribution: { [workflow]: count }    // summary counts per workflow
 *   }
 *
 * Sample selection:
 *   - Read `.claude/context/session.json.active_work.route_decisions[]` (if present).
 *   - Keep entries from the last 7 days OR the last 5 entries (whichever is
 *     larger), as required by REQ-001.
 *   - If the log is absent/empty, emit `sample_size: 0` + `bootstrap_note`.
 *
 * Pattern: mirrors `.claude/scripts/metrics/pipeline-efficiency-ws3-collect.mjs`
 * — parseArgs, pure-computation `run()` that returns
 *   `{ok, exit, payload, diagnostics}` without side effects, testable exports,
 *   `main()` that handles process.exit and stdio at the top level only.
 *
 * Usage:
 *   node pipeline-efficiency-routing-thresholds-collect.mjs \
 *     [--session-path <path>] \
 *     [--output-path <path>] \
 *     [--run-id <override-run-id>] \
 *     [--keep-last-n <N>] \
 *     [--keep-last-days <D>]
 *
 * Output:
 *   JSON payload to stdout. If --output-path is given, also written there.
 *   Informational diagnostics to stderr.
 *
 * Exit codes:
 *   0 - Success (including T0 empty-log case).
 *   1 - Runtime error (e.g., session.json unreadable).
 *   2 - Invocation error (bad args).
 *
 * Owner: .claude/docs/ROUTING.md.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_SESSION_PATH = '.claude/context/session.json';
const DEFAULT_KEEP_LAST_N = 5;
const DEFAULT_KEEP_LAST_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const WORKSTREAM_ID = 'sg-pipeline-efficiency-routing-thresholds';

const EXIT_OK = 0;
const EXIT_RUNTIME_FAIL = 1;
const EXIT_USAGE = 2;

const ERR_SESSION_UNREADABLE = 'ERR_SESSION_UNREADABLE';
const ERR_INVALID_ARG = 'ERR_INVALID_ARG';
const ERR_WRITE_FAILED = 'ERR_WRITE_FAILED';

const T0_BOOTSTRAP_NOTE =
  'route_decisions[] log is empty (T0 case). ' +
  'The append-only log is newly introduced by the routing-threshold instrumentation; ' +
  'baseline population begins at this measurement point. ' +
  'Post-change impact is measurable by comparing future runs against this bootstrap baseline.';

// =============================================================================
// Arg parsing
// =============================================================================

function parseArgs(argv) {
  const args = {
    sessionPath: DEFAULT_SESSION_PATH,
    outputPath: null,
    runId: null,
    keepLastN: DEFAULT_KEEP_LAST_N,
    keepLastDays: DEFAULT_KEEP_LAST_DAYS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-path' && i + 1 < argv.length) {
      args.sessionPath = argv[++i];
    } else if ((a === '--output-path' || a === '--output') && i + 1 < argv.length) {
      // Accept both --output-path and --output (alias). EDGE-05 tests invoke
      // with --output <path>; ws3-collect uses --output-path. Both work.
      args.outputPath = argv[++i];
    } else if (a === '--run-id' && i + 1 < argv.length) {
      args.runId = argv[++i];
    } else if (a === '--keep-last-n' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        const err = new Error(
          `${ERR_INVALID_ARG}: --keep-last-n must be a non-negative integer; got ${argv[i]}`
        );
        err.code = ERR_INVALID_ARG;
        throw err;
      }
      args.keepLastN = n;
    } else if (a === '--keep-last-days' && i + 1 < argv.length) {
      const d = Number(argv[++i]);
      if (!Number.isFinite(d) || d < 0) {
        const err = new Error(
          `${ERR_INVALID_ARG}: --keep-last-days must be a non-negative number; got ${argv[i]}`
        );
        err.code = ERR_INVALID_ARG;
        throw err;
      }
      args.keepLastDays = d;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(EXIT_OK);
    } else {
      const err = new Error(`${ERR_INVALID_ARG}: unrecognized argument '${a}'`);
      err.code = ERR_INVALID_ARG;
      throw err;
    }
  }
  return args;
}

function printUsage() {
  // --help goes to stdout (conventional CLI pattern): tests check stdout, and
  // operators piping `--help | less` expect text on stdout. Runtime
  // diagnostics (from main()) still go to stderr.
  process.stdout.write(
    `Usage: node pipeline-efficiency-routing-thresholds-collect.mjs \\\n` +
      `  [--session-path <path>]          Source session.json (default: .claude/context/session.json)\n` +
      `  [--output-path <path>]           Optional: also write JSON to disk (alias: --output)\n` +
      `  [--output <path>]                Alias for --output-path\n` +
      `  [--run-id <id>]                  Override run id (default: ISO timestamp with : -> -)\n` +
      `  [--keep-last-n <N>]              Keep last N entries (default: ${DEFAULT_KEEP_LAST_N})\n` +
      `  [--keep-last-days <D>]           Keep entries from last D days (default: ${DEFAULT_KEEP_LAST_DAYS})\n` +
      `  [--help | -h]                    Show this help and exit 0\n` +
      `\n` +
      `Emits a baseline JSON payload to stdout capturing recent /route decisions.\n` +
      `On an empty log (T0 case), emits sample_size: 0 with bootstrap_note; exits 0.\n`
  );
}

// =============================================================================
// I/O helpers
// =============================================================================

function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    const wrapped = new Error(
      `${ERR_SESSION_UNREADABLE}: ${path} is not valid JSON: ${err.message}`
    );
    wrapped.code = ERR_SESSION_UNREADABLE;
    throw wrapped;
  }
}

// =============================================================================
// Core logic (pure)
// =============================================================================

/**
 * Extract the route-decisions array from a session object, defaulting to [].
 *
 * @param {object|null} session
 * @returns {Array<object>}
 */
function extractRouteDecisions(session) {
  if (!session || typeof session !== 'object') return [];
  const active = session.active_work;
  if (!active || typeof active !== 'object') return [];
  const decisions = active.route_decisions;
  if (!Array.isArray(decisions)) return [];
  return decisions;
}

/**
 * Select the sample set per REQ-001:
 *   keep last N OR last D days, whichever yields more entries.
 *
 * Entries without parseable timestamps are retained and treated as "old enough"
 * for the keep-last-N branch but excluded from the time-window branch. This
 * matches ws3-collect's log-and-continue discipline for malformed entries.
 *
 * @param {Array<object>} decisions append-only log (oldest -> newest ideally;
 *                                   we don't assume ordering, we sort by ts)
 * @param {{keepLastN: number, keepLastDays: number, now?: Date}} opts
 * @returns {Array<object>} selected subset (newest-first)
 */
function selectSample(decisions, opts) {
  const { keepLastN, keepLastDays } = opts;
  const now = (opts.now instanceof Date ? opts.now : new Date()).getTime();
  const windowStart = now - keepLastDays * DAY_MS;

  // Attach parsed timestamps for sorting; keep originals untouched.
  const annotated = decisions.map((d) => {
    const ts = typeof d.timestamp === 'string' ? d.timestamp : null;
    const tms = ts ? new Date(ts).getTime() : NaN;
    return { d, tms };
  });

  // Sort newest-first. Entries with NaN timestamps sink to the end.
  annotated.sort((a, b) => {
    const at = Number.isFinite(a.tms) ? a.tms : -Infinity;
    const bt = Number.isFinite(b.tms) ? b.tms : -Infinity;
    return bt - at;
  });

  // Window selection: keep entries within [windowStart, now].
  const withinWindow = annotated.filter(
    (x) => Number.isFinite(x.tms) && x.tms >= windowStart && x.tms <= now
  );

  // Last-N selection: first N entries after sort.
  const lastN = annotated.slice(0, keepLastN);

  // "Whichever yields more" per REQ-001.
  const picked = withinWindow.length >= lastN.length ? withinWindow : lastN;

  return picked.map((x) => x.d);
}

/**
 * Compute a per-workflow distribution summary for a sample.
 *
 * @param {Array<object>} sample selected decisions
 * @returns {Record<string, number>}
 */
function computeDistribution(sample) {
  const dist = {};
  for (const d of sample) {
    const wf = typeof d.workflow === 'string' ? d.workflow : 'unknown';
    dist[wf] = (dist[wf] || 0) + 1;
  }
  return dist;
}

/**
 * Resolve run-id. Explicit override wins; otherwise ISO timestamp with `:`
 * replaced by `-` (matches ws3-collect.mjs convention).
 *
 * @param {string|null} cliRunId
 * @param {string} nowIso
 * @returns {string}
 */
function resolveRunId(cliRunId, nowIso) {
  if (typeof cliRunId === 'string' && cliRunId.length > 0) return cliRunId;
  return nowIso.replace(/:/g, '-');
}

/**
 * Build the baseline payload. Pure — does not touch fs or clock.
 *
 * @param {object} inputs
 * @returns {object}
 */
function buildPayload({ runId, publishedAt, sample, keepLastN, keepLastDays }) {
  const sampleSize = sample.length;
  const distribution = computeDistribution(sample);

  const payload = {
    workstream_id: WORKSTREAM_ID,
    run_id: runId,
    published_at: publishedAt,
    sample_size: sampleSize,
    sample_set_description:
      `Sample selection: last ${keepLastN} entries OR last ${keepLastDays} days ` +
      `(whichever yields more) from session.active_work.route_decisions[]. ` +
      `sample_size=${sampleSize}; distribution=${JSON.stringify(distribution)}.`,
    decisions: sample.map((d) => ({
      timestamp: typeof d.timestamp === 'string' ? d.timestamp : null,
      workflow: typeof d.workflow === 'string' ? d.workflow : null,
      rationale_excerpt:
        typeof d.rationale_excerpt === 'string' ? d.rationale_excerpt : null,
      multi_domain_justification: Array.isArray(d.multi_domain_justification)
        ? d.multi_domain_justification
        : null,
    })),
    distribution,
  };

  if (sampleSize === 0) {
    payload.bootstrap_note = T0_BOOTSTRAP_NOTE;
  }

  return payload;
}

// =============================================================================
// Orchestrator (testable — no process.exit, no stdio)
// =============================================================================

/**
 * Entry point for programmatic invocation. Returns a result object:
 *   { ok: true,  exit: 0, payload, diagnostics }   — success
 *   { ok: false, exit: N, error, message }         — failure
 *
 * Does NOT write to stdout/stderr or call process.exit. Caller (main) handles
 * that. Enables unit testing without subprocess fixtures.
 */
function run(args, { now = () => new Date() } = {}) {
  let session;
  try {
    session = readJsonOrNull(args.sessionPath);
  } catch (err) {
    return {
      ok: false,
      exit: EXIT_RUNTIME_FAIL,
      error: err.code || 'ERR_UNKNOWN',
      message: err.message,
    };
  }

  const allDecisions = extractRouteDecisions(session);
  const nowDate = now();
  const publishedAt = nowDate.toISOString();
  const sample = selectSample(allDecisions, {
    keepLastN: args.keepLastN,
    keepLastDays: args.keepLastDays,
    now: nowDate,
  });

  const runId = resolveRunId(args.runId, publishedAt);
  const payload = buildPayload({
    runId,
    publishedAt,
    sample,
    keepLastN: args.keepLastN,
    keepLastDays: args.keepLastDays,
  });

  return {
    ok: true,
    exit: EXIT_OK,
    payload,
    diagnostics: {
      session_path: args.sessionPath,
      session_present: session !== null,
      route_decisions_total: allDecisions.length,
      sample_selected: sample.length,
      t0_empty_log: sample.length === 0,
    },
  };
}

// =============================================================================
// Main (CLI)
// =============================================================================

function writeArtifactToDisk(outputPath, payload) {
  try {
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n');
  } catch (err) {
    const wrapped = new Error(
      `${ERR_WRITE_FAILED}: cannot write baseline to ${outputPath}: ${err.message}`
    );
    wrapped.code = ERR_WRITE_FAILED;
    throw wrapped;
  }
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(EXIT_USAGE);
  }

  let result;
  try {
    result = run(args);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(EXIT_RUNTIME_FAIL);
  }

  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(result.exit);
  }

  // Optional: write artifact to disk for the spec's Task 2 baseline commit.
  if (args.outputPath) {
    try {
      writeArtifactToDisk(resolve(args.outputPath), result.payload);
    } catch (err) {
      process.stderr.write(`ERROR: ${err.message}\n`);
      process.exit(EXIT_RUNTIME_FAIL);
    }
  }

  // Emit payload to stdout (JSON).
  process.stdout.write(JSON.stringify(result.payload, null, 2) + '\n');

  // Informational diagnostics to stderr.
  const d = result.diagnostics;
  const t0Note = d.t0_empty_log ? ' (T0 empty-log bootstrap)' : '';
  process.stderr.write(
    `routing-thresholds baseline: workstream_id=${result.payload.workstream_id}, ` +
      `run_id=${result.payload.run_id}, ` +
      `total_logged=${d.route_decisions_total}, ` +
      `sample_size=${d.sample_selected}${t0Note}\n`
  );
  process.exit(EXIT_OK);
}

// =============================================================================
// Exports (testing)
// =============================================================================

export {
  parseArgs,
  readJsonOrNull,
  extractRouteDecisions,
  selectSample,
  computeDistribution,
  resolveRunId,
  buildPayload,
  run,
  // Constants
  WORKSTREAM_ID,
  DEFAULT_KEEP_LAST_N,
  DEFAULT_KEEP_LAST_DAYS,
  T0_BOOTSTRAP_NOTE,
  ERR_SESSION_UNREADABLE,
  ERR_INVALID_ARG,
  ERR_WRITE_FAILED,
};

// CLI entrypoint (only when invoked directly).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
