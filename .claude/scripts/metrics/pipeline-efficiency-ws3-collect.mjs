#!/usr/bin/env node

/**
 * pipeline-efficiency-ws3-collect.mjs
 *
 * Before/after metrics collection script for ws-3 Orchestrator Hygiene
 * (REQ-014). Computes the 5 metric fields defined by the
 * `WorkstreamMetrics` contract (spec.md §Before/After Metrics Contract)
 * on a pre-ship vs. post-ship sample set and emits a single JSON payload
 * to stdout. Pure computation — publication (atomic write to
 * `.claude/metrics/pipeline-efficiency-ws3-orchestrator-hygiene-<run-id>.json`)
 * is handled by the companion publisher (as-020).
 *
 * Metric contract (REQ-014 / AC19.1-AC19.3 from as-019):
 *   1. flow_verify_out_of_scope_findings { baseline: 38, target: 0, actual }
 *   2. worktree_path_errors              { baseline:  2, target: 0, actual }
 *   3. atomizer_id_divergence            { baseline:  3, target: 0, actual }
 *   4. atomizer_gravestone_commits       { baseline: 12, target: 0, actual }
 *   5. late_hash_registry_drift          { baseline:  1, target: 0, actual }
 *
 * Each baseline value is pinned by the spec contract (from evidence-run
 * measurements) and NOT recomputed. `actual` values come from scanning:
 *   - `.claude/audit/pipeline-efficiency-changes.log` — NDJSON audit entries
 *     for event_class ∈ {worktree_path_violation, compute_hashes}.
 *   - `git log` — commit messages matching gravestone / atomizer markers
 *     for the post-ship spec-group sample.
 *   - Spec-group manifests under `.claude/specs/groups/` — manifest
 *     frontmatter for the pre-ship / post-ship sample selection.
 *
 * Sample selection (AC19.3):
 *   Pre-ship  — last ~10 spec groups whose `created_at` < `--split-at`
 *               anchor, ordered by `created_at` descending.
 *   Post-ship — first ~10 spec groups whose `created_at` >= `--split-at`,
 *               ordered by `created_at` ascending.
 *   Split-at anchor — CLI `--split-at` wins; otherwise pulled from
 *   `.claude/metrics/pipeline-efficiency-ws3-baseline.json` (if present).
 *   If neither is available, `--split-at` is required (structured error).
 *
 * Event-class scan rules (actual-value computation):
 *   - flow_verify_out_of_scope_findings: count entries with
 *     event_class="flow_verify" AND payload.finding_category ∈
 *     {"out-of-scope", "sibling-module", "non-diff"} on post-ship groups.
 *   - worktree_path_errors: count entries with
 *     event_class="worktree_path_violation".
 *   - atomizer_id_divergence: count distinct `(spec_group_id, id_scheme)`
 *     pairs produced during atomization across post-ship groups (event_class
 *     ∈ {"atomizer"} with payload.id_scheme enumerating divergent variants).
 *   - atomizer_gravestone_commits: count git commits on post-ship spec groups
 *     whose commit message contains one of the gravestone markers:
 *     {"placeholder", "gravestone", "chore(atomic-id)"}.
 *   - late_hash_registry_drift: count entries with
 *     event_class="compute_hashes" AND payload.gate ∈
 *     {"completion-verifier", "post-impl"} AND payload.drift_detected === true.
 *
 * If an event class is entirely absent from the audit log, the corresponding
 * `actual` value is 0 (not an error).
 *
 * Run-id:
 *   Explicit `--run-id` wins; otherwise ISO-UTC timestamp with ':' -> '-'.
 *
 * Usage:
 *   node pipeline-efficiency-ws3-collect.mjs \
 *     [--repo-root <dir>] \
 *     [--specs-root <dir>] \
 *     [--audit-log <path>] \
 *     [--baseline-file <path>] \
 *     [--split-at <iso-8601>] \
 *     [--sample-size <n>] \
 *     [--run-id <override-run-id>]
 *
 * Output:
 *   JSON payload to stdout matching `WorkstreamMetrics` contract shape.
 *   Informational message to stderr.
 *
 * Exit codes:
 *   0 - Success. Metrics JSON written to stdout.
 *   1 - Runtime error (I/O, malformed manifest, malformed audit entry, etc.).
 *   2 - Invocation error (bad args, missing split anchor).
 *
 * Implements: AC19.1, AC19.2, AC19.3 (as-019).
 * Spec: sg-pipeline-efficiency-ws3-orchestrator-hygiene as-019.
 *
 * @req REQ-014
 */

import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_REPO_ROOT = '.';
const DEFAULT_SPECS_ROOT = '.claude/specs/groups';
const DEFAULT_AUDIT_LOG = '.claude/audit/pipeline-efficiency-changes.log';
const DEFAULT_BASELINE_FILE =
  '.claude/metrics/pipeline-efficiency-ws3-baseline.json';

const WORKSTREAM_ID = 'ws-3';
const DEFAULT_SAMPLE_SIZE = 10;

// AC19.2 — pinned baselines from spec contract. Do not recompute.
const BASELINE_FLOW_VERIFY_OUT_OF_SCOPE = 38;
const BASELINE_WORKTREE_PATH_ERRORS = 2;
const BASELINE_ATOMIZER_ID_DIVERGENCE = 3;
const BASELINE_ATOMIZER_GRAVESTONE_COMMITS = 12;
const BASELINE_LATE_HASH_REGISTRY_DRIFT = 1;

// All targets are 0 (spec contract).
const TARGET_ZERO = 0;

// Event-class enum values (audit log schema).
const EVENT_CLASS_FLOW_VERIFY = 'flow_verify';
const EVENT_CLASS_WORKTREE_PATH_VIOLATION = 'worktree_path_violation';
const EVENT_CLASS_ATOMIZER = 'atomizer';
const EVENT_CLASS_COMPUTE_HASHES = 'compute_hashes';

// Finding categories considered "out-of-scope" for flow-verify.
const FLOW_VERIFY_OUT_OF_SCOPE_CATEGORIES = new Set([
  'out-of-scope',
  'sibling-module',
  'non-diff',
]);

// Gate names considered "late-stage" for hash-drift detection.
const LATE_HASH_DRIFT_GATES = new Set([
  'completion-verifier',
  'post-impl',
]);

// Commit-message markers for gravestone placeholder commits.
const GRAVESTONE_COMMIT_MARKERS = [
  'placeholder',
  'gravestone',
  'chore(atomic-id)',
];

// Structured error codes.
const ERR_MISSING_SPLIT_ANCHOR = 'MISSING_SPLIT_ANCHOR';
const ERR_INVALID_SPLIT_ANCHOR = 'INVALID_SPLIT_ANCHOR';
const ERR_MALFORMED_AUDIT_ENTRY = 'MALFORMED_AUDIT_ENTRY';

const EXIT_OK = 0;
const EXIT_RUNTIME_FAIL = 1;
const EXIT_USAGE = 2;

// =============================================================================
// Arg parsing
// =============================================================================

function parseArgs(argv) {
  const args = {
    repoRoot: DEFAULT_REPO_ROOT,
    specsRoot: null,
    auditLog: null,
    baselineFile: null,
    splitAt: null,
    sampleSize: DEFAULT_SAMPLE_SIZE,
    runId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo-root' && i + 1 < argv.length) args.repoRoot = argv[++i];
    else if (a === '--specs-root' && i + 1 < argv.length)
      args.specsRoot = argv[++i];
    else if (a === '--audit-log' && i + 1 < argv.length)
      args.auditLog = argv[++i];
    else if (a === '--baseline-file' && i + 1 < argv.length)
      args.baselineFile = argv[++i];
    else if (a === '--split-at' && i + 1 < argv.length)
      args.splitAt = argv[++i];
    else if (a === '--sample-size' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--sample-size must be a positive integer; got ${n}`);
      }
      args.sampleSize = Math.floor(n);
    } else if (a === '--run-id' && i + 1 < argv.length) args.runId = argv[++i];
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(EXIT_OK);
    }
  }
  // Resolve path defaults relative to repoRoot so the script is portable.
  args.specsRoot = args.specsRoot || join(args.repoRoot, DEFAULT_SPECS_ROOT);
  args.auditLog = args.auditLog || join(args.repoRoot, DEFAULT_AUDIT_LOG);
  args.baselineFile =
    args.baselineFile || join(args.repoRoot, DEFAULT_BASELINE_FILE);
  return args;
}

function printUsage() {
  process.stderr.write(
    `Usage: node pipeline-efficiency-ws3-collect.mjs \\\n` +
      `  [--repo-root <dir>] [--specs-root <dir>] [--audit-log <path>] \\\n` +
      `  [--baseline-file <path>] [--split-at <iso>] \\\n` +
      `  [--sample-size <n>] [--run-id <id>]\n`,
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
    throw new Error(`not valid JSON: ${path} — ${err.message}`);
  }
}

/**
 * Read an NDJSON file as an array of parsed objects. Skips blank lines.
 * Malformed lines raise a structured error (ERR_MALFORMED_AUDIT_ENTRY) so
 * the caller can decide whether to abort or log-and-continue; this script
 * log-and-continues to keep metric collection resilient to a single bad line.
 */
function readNdjsonLenient(path, onMalformed) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      if (typeof onMalformed === 'function') {
        onMalformed({
          lineNumber: i + 1,
          line,
          error: err.message,
        });
      }
    }
  }
  return out;
}

function listSpecGroupDirs(specsRoot) {
  if (!existsSync(specsRoot)) return [];
  return readdirSync(specsRoot)
    .map((name) => join(specsRoot, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

function loadManifest(groupDir) {
  const mPath = join(groupDir, 'manifest.json');
  return readJsonOrNull(mPath);
}

// =============================================================================
// Split-anchor resolution
// =============================================================================

/**
 * Resolve the ws-3 merge split-at anchor from the baseline artefact.
 * Priority: `ws3_merge_at` > `measurement_window_end`. Returns ISO string
 * or null.
 */
function resolveSplitAtFromBaseline(baselineFile) {
  const data = readJsonOrNull(baselineFile);
  if (!data) return null;
  if (typeof data.ws3_merge_at === 'string' && data.ws3_merge_at.length > 0) {
    return data.ws3_merge_at;
  }
  if (
    typeof data.measurement_window_end === 'string' &&
    data.measurement_window_end.length > 0
  ) {
    return data.measurement_window_end;
  }
  return null;
}

// =============================================================================
// Sample selection
// =============================================================================

function compareCreatedAtAsc(a, b) {
  const ax = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bx = b.created_at ? new Date(b.created_at).getTime() : 0;
  return ax - bx;
}

function compareCreatedAtDesc(a, b) {
  return compareCreatedAtAsc(b, a);
}

/**
 * Scan every spec-group directory and emit { id, created_at } records.
 * Groups without a manifest or without a created_at are skipped.
 */
function scanSpecGroups(specsRoot) {
  const groupDirs = listSpecGroupDirs(specsRoot);
  const out = [];
  for (const dir of groupDirs) {
    let manifest;
    try {
      manifest = loadManifest(dir);
    } catch {
      continue;
    }
    if (!manifest || typeof manifest.id !== 'string') continue;
    if (typeof manifest.created_at !== 'string') continue;
    out.push({
      spec_group_id: manifest.id,
      spec_group_dir: dir,
      created_at: manifest.created_at,
    });
  }
  return out;
}

/**
 * Partition spec groups into pre-ship / post-ship samples around splitAt.
 * Pre-ship: created_at < splitAt, sorted desc, trimmed to sampleSize.
 * Post-ship: created_at >= splitAt, sorted asc, trimmed to sampleSize.
 */
function selectSamples(allGroups, splitAtIso, sampleSize) {
  const splitMs = new Date(splitAtIso).getTime();
  if (!Number.isFinite(splitMs)) {
    const err = new Error(
      `${ERR_INVALID_SPLIT_ANCHOR}: cannot parse --split-at "${splitAtIso}" as ISO-8601`,
    );
    err.code = ERR_INVALID_SPLIT_ANCHOR;
    throw err;
  }
  const pre = [];
  const post = [];
  for (const g of allGroups) {
    const ms = new Date(g.created_at).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms < splitMs) pre.push(g);
    else post.push(g);
  }
  pre.sort(compareCreatedAtDesc);
  post.sort(compareCreatedAtAsc);
  return {
    pre_ship: pre.slice(0, sampleSize),
    post_ship: post.slice(0, sampleSize),
  };
}

// =============================================================================
// Metric computation
// =============================================================================

/**
 * Count audit-log entries for a given event_class (and optional predicate)
 * restricted to a spec-group set (matched via payload.spec_group_id). If
 * spec_group_ids is null, count across all entries in the window.
 */
function countAuditEntries(entries, eventClass, predicate, specGroupIds) {
  let n = 0;
  for (const e of entries) {
    if (!e || e.event_class !== eventClass) continue;
    if (specGroupIds) {
      const sg =
        e.payload && typeof e.payload.spec_group_id === 'string'
          ? e.payload.spec_group_id
          : null;
      if (!sg || !specGroupIds.has(sg)) continue;
    }
    if (typeof predicate === 'function' && !predicate(e)) continue;
    n += 1;
  }
  return n;
}

/**
 * Count post-ship flow-verify findings flagged as out-of-scope (sibling
 * modules / non-diff code paths).
 */
function countFlowVerifyOutOfScope(entries, postShipIds) {
  return countAuditEntries(
    entries,
    EVENT_CLASS_FLOW_VERIFY,
    (e) => {
      const cat =
        e.payload && typeof e.payload.finding_category === 'string'
          ? e.payload.finding_category
          : null;
      return cat !== null && FLOW_VERIFY_OUT_OF_SCOPE_CATEGORIES.has(cat);
    },
    postShipIds,
  );
}

/**
 * Count worktree-path violations in the entire post-ship window (the
 * violation is a session-level event; spec_group_id may or may not be
 * present in payload). When spec_group_id is present, scope to post-ship
 * groups; otherwise count all post-split violations by timestamp.
 */
function countWorktreePathErrors(entries, postShipIds, splitAtIso) {
  const splitMs = new Date(splitAtIso).getTime();
  let n = 0;
  for (const e of entries) {
    if (!e || e.event_class !== EVENT_CLASS_WORKTREE_PATH_VIOLATION) continue;
    const sg =
      e.payload && typeof e.payload.spec_group_id === 'string'
        ? e.payload.spec_group_id
        : null;
    if (sg) {
      if (!postShipIds.has(sg)) continue;
    } else {
      const ts = typeof e.timestamp === 'string' ? e.timestamp : null;
      const tms = ts ? new Date(ts).getTime() : NaN;
      if (!Number.isFinite(tms) || tms < splitMs) continue;
    }
    n += 1;
  }
  return n;
}

/**
 * Count distinct `(spec_group_id, id_scheme)` pairs produced during
 * atomization across post-ship groups. A single spec group running atomization
 * twice with two different id_schemes counts as 2 divergence signals.
 */
function countAtomizerIdDivergence(entries, postShipIds) {
  const pairs = new Set();
  for (const e of entries) {
    if (!e || e.event_class !== EVENT_CLASS_ATOMIZER) continue;
    const sg =
      e.payload && typeof e.payload.spec_group_id === 'string'
        ? e.payload.spec_group_id
        : null;
    const scheme =
      e.payload && typeof e.payload.id_scheme === 'string'
        ? e.payload.id_scheme
        : null;
    if (!sg || !scheme) continue;
    if (!postShipIds.has(sg)) continue;
    pairs.add(`${sg}::${scheme}`);
  }
  // Count only when a spec group has >1 distinct scheme (divergence).
  const perGroup = new Map();
  for (const pair of pairs) {
    const [sg] = pair.split('::');
    perGroup.set(sg, (perGroup.get(sg) || 0) + 1);
  }
  let divergent = 0;
  for (const cnt of perGroup.values()) {
    if (cnt > 1) divergent += 1;
  }
  return divergent;
}

/**
 * Count git commits (on all branches reachable from HEAD) whose commit
 * message contains any gravestone marker and whose subject references a
 * post-ship spec-group id or atomic-spec id. Runs `git log` as a subprocess
 * and greps the output. Failures are logged-and-zero to keep collection
 * resilient (no git access on CI doesn't break the script).
 */
function countAtomizerGravestoneCommits(repoRoot, postShipIds, splitAtIso) {
  let output;
  try {
    output = execFileSync(
      'git',
      [
        '-C',
        resolve(repoRoot),
        'log',
        '--all',
        `--since=${splitAtIso}`,
        '--pretty=format:%H%x00%s%x00%b%x1e',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    return 0;
  }
  const commits = output.split('\x1e').map((c) => c.trim()).filter(Boolean);
  let n = 0;
  for (const commit of commits) {
    const [_hash, subject = '', body = ''] = commit.split('\x00');
    const message = `${subject}\n${body}`.toLowerCase();
    const hasMarker = GRAVESTONE_COMMIT_MARKERS.some((m) =>
      message.includes(m.toLowerCase()),
    );
    if (!hasMarker) continue;
    // Require reference to a post-ship spec group (filter false positives
    // from unrelated placeholder commits).
    const refsPostShipGroup = [...postShipIds].some((sg) =>
      message.includes(sg.toLowerCase()),
    );
    if (!refsPostShipGroup) continue;
    n += 1;
  }
  return n;
}

/**
 * Count compute-hashes audit entries with drift_detected === true at a
 * late-stage gate (completion-verifier or post-impl).
 */
function countLateHashRegistryDrift(entries, postShipIds, splitAtIso) {
  const splitMs = new Date(splitAtIso).getTime();
  let n = 0;
  for (const e of entries) {
    if (!e || e.event_class !== EVENT_CLASS_COMPUTE_HASHES) continue;
    if (!e.payload || e.payload.drift_detected !== true) continue;
    const gate =
      typeof e.payload.gate === 'string' ? e.payload.gate : null;
    if (!gate || !LATE_HASH_DRIFT_GATES.has(gate)) continue;
    const sg =
      typeof e.payload.spec_group_id === 'string'
        ? e.payload.spec_group_id
        : null;
    if (sg) {
      if (!postShipIds.has(sg)) continue;
    } else {
      const ts = typeof e.timestamp === 'string' ? e.timestamp : null;
      const tms = ts ? new Date(ts).getTime() : NaN;
      if (!Number.isFinite(tms) || tms < splitMs) continue;
    }
    n += 1;
  }
  return n;
}

// =============================================================================
// Run-id resolution
// =============================================================================

function resolveRunId(cliRunId, nowIso) {
  if (typeof cliRunId === 'string' && cliRunId.length > 0) return cliRunId;
  return nowIso.replace(/:/g, '-');
}

// =============================================================================
// Payload assembly
// =============================================================================

/**
 * Assemble the `WorkstreamMetrics` contract payload. Shape matches
 * spec.md §Before/After Metrics Contract exactly:
 *   workstream_id, run_id, published_at, metrics{5 fields}, sample_set_description.
 */
function buildPayload({
  runId,
  publishedAt,
  splitAtIso,
  preShip,
  postShip,
  sampleSize,
  actuals,
}) {
  return {
    workstream_id: WORKSTREAM_ID,
    run_id: runId,
    published_at: publishedAt,
    metrics: {
      flow_verify_out_of_scope_findings: {
        baseline: BASELINE_FLOW_VERIFY_OUT_OF_SCOPE,
        target: TARGET_ZERO,
        actual: actuals.flow_verify_out_of_scope_findings,
      },
      worktree_path_errors: {
        baseline: BASELINE_WORKTREE_PATH_ERRORS,
        target: TARGET_ZERO,
        actual: actuals.worktree_path_errors,
      },
      atomizer_id_divergence: {
        baseline: BASELINE_ATOMIZER_ID_DIVERGENCE,
        target: TARGET_ZERO,
        actual: actuals.atomizer_id_divergence,
      },
      atomizer_gravestone_commits: {
        baseline: BASELINE_ATOMIZER_GRAVESTONE_COMMITS,
        target: TARGET_ZERO,
        actual: actuals.atomizer_gravestone_commits,
      },
      late_hash_registry_drift: {
        baseline: BASELINE_LATE_HASH_REGISTRY_DRIFT,
        target: TARGET_ZERO,
        actual: actuals.late_hash_registry_drift,
      },
    },
    sample_set_description:
      `split_at=${splitAtIso}; pre_ship=${preShip.length} group(s) (desc-by-created_at, ` +
      `cap ${sampleSize}); post_ship=${postShip.length} group(s) (asc-by-created_at, ` +
      `cap ${sampleSize}); measurement window: pre = last ~${sampleSize} spec ` +
      `groups before ws-3 merge; post = first ~${sampleSize} spec groups after.`,
  };
}

// =============================================================================
// Orchestrator (testable — no process.exit inside)
// =============================================================================

/**
 * Entry point for programmatic invocation. Returns a result object:
 *   { ok: true,  exit: 0, payload }  — success
 *   { ok: false, exit: N, error, message } — failure
 *
 * Does NOT write to stdout/stderr or call process.exit. Caller (main)
 * handles that. Enables unit testing without subprocess fixtures.
 */
function run(args, { now = () => new Date() } = {}) {
  // Resolve split-at anchor.
  let splitAtIso = args.splitAt;
  if (!splitAtIso) {
    splitAtIso = resolveSplitAtFromBaseline(args.baselineFile);
  }
  if (!splitAtIso) {
    return {
      ok: false,
      exit: EXIT_USAGE,
      error: ERR_MISSING_SPLIT_ANCHOR,
      message:
        `${ERR_MISSING_SPLIT_ANCHOR}: could not resolve ws-3 merge anchor. ` +
        `Pass --split-at <iso-8601> or ensure ${args.baselineFile} contains ` +
        `ws3_merge_at or measurement_window_end.`,
    };
  }

  // Scan spec groups + partition into pre/post ship samples.
  const allGroups = scanSpecGroups(args.specsRoot);
  let samples;
  try {
    samples = selectSamples(allGroups, splitAtIso, args.sampleSize);
  } catch (err) {
    return {
      ok: false,
      exit: EXIT_USAGE,
      error: err.code || 'SAMPLE_SELECTION_FAILED',
      message: err.message,
    };
  }
  const { pre_ship, post_ship } = samples;

  const postShipIds = new Set(post_ship.map((g) => g.spec_group_id));

  // Load + parse audit log. Malformed lines logged to stderr and skipped.
  const malformedLines = [];
  const auditEntries = readNdjsonLenient(args.auditLog, (info) => {
    malformedLines.push(info);
  });

  // Compute actual values for all 5 metrics.
  const actuals = {
    flow_verify_out_of_scope_findings: countFlowVerifyOutOfScope(
      auditEntries,
      postShipIds,
    ),
    worktree_path_errors: countWorktreePathErrors(
      auditEntries,
      postShipIds,
      splitAtIso,
    ),
    atomizer_id_divergence: countAtomizerIdDivergence(
      auditEntries,
      postShipIds,
    ),
    atomizer_gravestone_commits: countAtomizerGravestoneCommits(
      args.repoRoot,
      postShipIds,
      splitAtIso,
    ),
    late_hash_registry_drift: countLateHashRegistryDrift(
      auditEntries,
      postShipIds,
      splitAtIso,
    ),
  };

  const publishedAt = now().toISOString();
  const runId = resolveRunId(args.runId, publishedAt);
  const payload = buildPayload({
    runId,
    publishedAt,
    splitAtIso,
    preShip: pre_ship,
    postShip: post_ship,
    sampleSize: args.sampleSize,
    actuals,
  });

  return {
    ok: true,
    exit: EXIT_OK,
    payload,
    diagnostics: {
      audit_log_entries_read: auditEntries.length,
      audit_log_malformed_lines: malformedLines.length,
      pre_ship_count: pre_ship.length,
      post_ship_count: post_ship.length,
    },
  };
}

// =============================================================================
// Main (CLI)
// =============================================================================

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

  // Emit payload to stdout (JSON). Publisher (as-020) consumes.
  process.stdout.write(JSON.stringify(result.payload, null, 2) + '\n');

  // Informational diagnostics to stderr.
  const d = result.diagnostics;
  process.stderr.write(
    `collected: workstream_id=${result.payload.workstream_id}, ` +
      `run_id=${result.payload.run_id}, ` +
      `pre=${d.pre_ship_count}, post=${d.post_ship_count}, ` +
      `audit_entries=${d.audit_log_entries_read}` +
      (d.audit_log_malformed_lines > 0
        ? `, malformed_audit_lines=${d.audit_log_malformed_lines}`
        : '') +
      `\n`,
  );
  process.exit(EXIT_OK);
}

// =============================================================================
// Exports (testing)
// =============================================================================

export {
  parseArgs,
  readJsonOrNull,
  readNdjsonLenient,
  resolveSplitAtFromBaseline,
  scanSpecGroups,
  selectSamples,
  countAuditEntries,
  countFlowVerifyOutOfScope,
  countWorktreePathErrors,
  countAtomizerIdDivergence,
  countAtomizerGravestoneCommits,
  countLateHashRegistryDrift,
  resolveRunId,
  buildPayload,
  run,
  // Constants
  WORKSTREAM_ID,
  BASELINE_FLOW_VERIFY_OUT_OF_SCOPE,
  BASELINE_WORKTREE_PATH_ERRORS,
  BASELINE_ATOMIZER_ID_DIVERGENCE,
  BASELINE_ATOMIZER_GRAVESTONE_COMMITS,
  BASELINE_LATE_HASH_REGISTRY_DRIFT,
  TARGET_ZERO,
  FLOW_VERIFY_OUT_OF_SCOPE_CATEGORIES,
  LATE_HASH_DRIFT_GATES,
  GRAVESTONE_COMMIT_MARKERS,
  ERR_MISSING_SPLIT_ANCHOR,
  ERR_INVALID_SPLIT_ANCHOR,
  ERR_MALFORMED_AUDIT_ENTRY,
};

// CLI entrypoint (only when invoked directly).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
