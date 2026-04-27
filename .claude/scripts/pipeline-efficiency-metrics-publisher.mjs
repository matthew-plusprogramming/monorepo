#!/usr/bin/env node

/**
 * pipeline-efficiency-metrics-publisher.mjs
 *
 * Post-merge metrics publisher for ws-1 (REQ-016). Audits
 * `session.json.convergence_evidence[gate].passes[]` and emits a per-run
 * metrics file at `.claude/metrics/pipeline-efficiency-ws1-<run-id>.json`.
 *
 * Metric contract (REQ-016 / AC26.1):
 *   - redundancy_rate: fraction of passes that are zero-finding AND whose
 *     `findings_hash` is identical to the immediately prior pass for the same
 *     gate (AC26.2). A pass with no prior pass in the same gate cannot be
 *     redundant — it establishes the first signal.
 *   - dispatch_count: total passes recorded across all gates (proxy for agent
 *     invocation count).
 *   - duplication_cost: absolute redundant-pass count (dispatch_count *
 *     redundancy_rate, rounded). Represents wasted iterations.
 *
 * Per-gate breakdown (AC26.1 requires iteration counts, pass/fail ratios,
 * wall-clock) is emitted under `per_gate`.
 *
 * Run-id (AC26.4 comparable sample set documentation): defaults to
 * `session.session_id` so the metrics file is 1:1 with the session that
 * produced it. Falls back to an ISO-8601 timestamp when session_id is missing
 * (cold-start invocations outside a live session).
 *
 * Usage:
 *   node pipeline-efficiency-metrics-publisher.mjs \
 *     [--session <path-to-session.json>] \
 *     [--out-dir <metrics-dir>] \
 *     [--run-id <override-run-id>]
 *
 *   Defaults:
 *     --session  .claude/context/session.json
 *     --out-dir  .claude/metrics
 *     --run-id   session.session_id || ISO-timestamp
 *
 * Exit codes:
 *   0 - Success. Metrics file written.
 *   1 - Runtime error (session unreadable, out-dir unwritable).
 *   2 - Invocation error (bad args).
 *
 * Implements: AC26.1, AC26.2, AC26.4.
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning as-026.
 *
 * @req REQ-016
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_SESSION_PATH = '.claude/context/session.json';
const DEFAULT_OUT_DIR = '.claude/metrics';
const FILENAME_PREFIX = 'pipeline-efficiency-ws1-';
const FILENAME_SUFFIX = '.json';

const EXIT_OK = 0;
const EXIT_RUNTIME_FAIL = 1;
const EXIT_USAGE = 2;

// =============================================================================
// Arg parsing
// =============================================================================

/**
 * Parse CLI args. Unknown flags are ignored to keep the surface stable across
 * call sites (post-merge hook, manual invocation).
 */
function parseArgs(argv) {
  const args = {
    session: DEFAULT_SESSION_PATH,
    outDir: DEFAULT_OUT_DIR,
    runId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session' && i + 1 < argv.length) args.session = argv[++i];
    else if (a === '--out-dir' && i + 1 < argv.length) args.outDir = argv[++i];
    else if (a === '--run-id' && i + 1 < argv.length) args.runId = argv[++i];
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(EXIT_OK);
    }
  }
  return args;
}

function printUsage() {
  process.stderr.write(
    `Usage: node pipeline-efficiency-metrics-publisher.mjs \\\n` +
      `  [--session <path>] [--out-dir <dir>] [--run-id <id>]\n`,
  );
}

// =============================================================================
// I/O helpers
// =============================================================================

function readSession(path) {
  if (!existsSync(path)) {
    throw new Error(`session file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`session file is not valid JSON: ${path} — ${err.message}`);
  }
}

function writeJson(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// =============================================================================
// Audit core (REQ-016 / AC26.2)
// =============================================================================

/**
 * Classify a pass as redundant per AC26.2.
 *
 * Redundant := findings_count === 0 AND findings_hash is a non-empty string
 * identical to the prior pass's findings_hash (same gate).
 *
 * Zero-finding passes WITHOUT a prior pass or WITHOUT a matching prior hash
 * are NOT redundant — they carry new information (first clean pass, or a
 * different hash means different finding landscape even if both empty).
 *
 * Note on hash comparison: we require a non-empty prior hash to avoid
 * treating two missing/absent hashes as a match. A legitimate empty-findings
 * pass may have a hash of the empty-finding canonical form; that shape is
 * consistent across well-formed records.
 *
 * @param {object} pass - current pass record
 * @param {object|null} prior - prior pass record for the same gate (or null)
 * @returns {boolean}
 */
function isRedundantPass(pass, prior) {
  if (!prior) return false;
  const findingsCount = Number.isInteger(pass.findings_count)
    ? pass.findings_count
    : Array.isArray(pass.findings)
      ? pass.findings.length
      : null;
  const currentHash =
    typeof pass.findings_hash === 'string' ? pass.findings_hash : pass.content_hash;
  const priorHash =
    typeof prior.findings_hash === 'string' ? prior.findings_hash : prior.content_hash;

  if (findingsCount !== 0) return false;
  if (typeof currentHash !== 'string' || currentHash.length === 0) {
    return false;
  }
  if (typeof priorHash !== 'string' || priorHash.length === 0) {
    return false;
  }
  return currentHash === priorHash;
}

/**
 * Compute wall-clock span for a sequence of passes using their `timestamp`
 * fields. Returns `{start, end, span_ms}` with nulls when the sequence is
 * empty or timestamps are unparseable. Timestamps out of monotonic order are
 * tolerated — the min/max bracket the window regardless.
 */
function computeWallClock(passes) {
  if (!Array.isArray(passes) || passes.length === 0) {
    return { start: null, end: null, span_ms: 0 };
  }
  let minMs = Infinity;
  let maxMs = -Infinity;
  let minIso = null;
  let maxIso = null;
  for (const p of passes) {
    if (typeof p.timestamp !== 'string') continue;
    const ms = new Date(p.timestamp).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms < minMs) {
      minMs = ms;
      minIso = p.timestamp;
    }
    if (ms > maxMs) {
      maxMs = ms;
      maxIso = p.timestamp;
    }
  }
  if (minMs === Infinity) {
    return { start: null, end: null, span_ms: 0 };
  }
  return { start: minIso, end: maxIso, span_ms: Math.max(0, maxMs - minMs) };
}

/**
 * Build the per-gate breakdown (iteration counts, pass/fail ratios, wall-clock).
 * Pure function — takes `passes[]` for a single gate and returns the metric
 * subset consumed under `per_gate[<gate>]` in the output file.
 */
function auditGate(passes) {
  const iteration_count = Array.isArray(passes) ? passes.length : 0;
  let clean_count = 0;
  let dirty_count = 0;
  let redundant_count = 0;

  for (let i = 0; i < iteration_count; i++) {
    const p = passes[i];
    const findingsCount = Number.isInteger(p.findings_count)
      ? p.findings_count
      : Array.isArray(p.findings)
        ? p.findings.length
        : null;
    if (p.clean === true || findingsCount === 0) clean_count += 1;
    else dirty_count += 1;

    const prior = i > 0 ? passes[i - 1] : null;
    if (isRedundantPass(p, prior)) redundant_count += 1;
  }

  const clean_ratio = iteration_count > 0 ? clean_count / iteration_count : 0;
  const fail_ratio = iteration_count > 0 ? dirty_count / iteration_count : 0;
  const redundancy_rate = iteration_count > 0 ? redundant_count / iteration_count : 0;

  return {
    iteration_count,
    clean_count,
    dirty_count,
    redundant_count,
    clean_ratio,
    fail_ratio,
    redundancy_rate,
    wall_clock: computeWallClock(passes),
  };
}

/**
 * Build the full metrics payload from session.json.
 */
function buildMetrics(session, runId, publishedAt) {
  const evidence = session.convergence_evidence || {};
  const gateNames = Object.keys(evidence).sort();

  const per_gate = {};
  let total_dispatches = 0;
  let total_redundant = 0;

  for (const gate of gateNames) {
    const passes = Array.isArray(evidence[gate]?.passes) ? evidence[gate].passes : [];
    const audit = auditGate(passes);
    per_gate[gate] = audit;
    total_dispatches += audit.iteration_count;
    total_redundant += audit.redundant_count;
  }

  const redundancy_rate =
    total_dispatches > 0 ? total_redundant / total_dispatches : 0;

  return {
    schema_version: 1,
    workstream_id: 'ws-1',
    run_id: runId,
    published_at: publishedAt,
    source_session_id: session.session_id || null,
    summary: {
      redundancy_rate,
      dispatch_count: total_dispatches,
      duplication_cost: total_redundant,
    },
    per_gate,
    sample_set: {
      // AC26.4: comparable sample set documentation. Post-ship publishers are
      // invoked once per run; aggregation across ~10 runs happens at the
      // baseline-accumulation layer (REQ-011). The per-run file is the
      // per-session slice that the aggregator consumes.
      scope: 'per-run',
      window_spec:
        'last ~10 spec groups pre-ship vs. first ~10 post-ship (REQ-016)',
      gate_count: gateNames.length,
    },
  };
}

// =============================================================================
// Run-id resolution
// =============================================================================

/**
 * Choose a run-id. Priority: explicit CLI override → session.session_id →
 * ISO timestamp fallback. The timestamp fallback is normalised to a
 * filename-safe shape (colons → hyphens) so the emitted filename is portable.
 */
function resolveRunId(session, cliRunId, nowIso) {
  if (typeof cliRunId === 'string' && cliRunId.length > 0) return cliRunId;
  if (typeof session.session_id === 'string' && session.session_id.length > 0) {
    return session.session_id;
  }
  return nowIso.replace(/:/g, '-');
}

// =============================================================================
// Main
// =============================================================================

function main(argv) {
  const args = parseArgs(argv);

  let session;
  try {
    session = readSession(resolve(args.session));
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(EXIT_RUNTIME_FAIL);
  }

  const publishedAt = new Date().toISOString();
  const runId = resolveRunId(session, args.runId, publishedAt);

  const metrics = buildMetrics(session, runId, publishedAt);

  const outFile = join(
    resolve(args.outDir),
    `${FILENAME_PREFIX}${runId}${FILENAME_SUFFIX}`,
  );

  try {
    writeJson(outFile, metrics);
  } catch (err) {
    process.stderr.write(`ERROR: failed to write metrics — ${err.message}\n`);
    process.exit(EXIT_RUNTIME_FAIL);
  }

  process.stderr.write(
    `published: ${outFile} (dispatches=${metrics.summary.dispatch_count}, ` +
      `redundancy_rate=${metrics.summary.redundancy_rate.toFixed(4)})\n`,
  );
  process.exit(EXIT_OK);
}

// Exports for test harness.
export {
  parseArgs,
  isRedundantPass,
  computeWallClock,
  auditGate,
  buildMetrics,
  resolveRunId,
};

// CLI entrypoint (only when invoked directly).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
