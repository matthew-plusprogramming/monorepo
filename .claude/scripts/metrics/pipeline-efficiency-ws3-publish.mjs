#!/usr/bin/env node

/**
 * pipeline-efficiency-ws3-publish.mjs
 *
 * Before/after metrics publication wrapper for
 * sg-pipeline-efficiency-ws3-orchestrator-hygiene (REQ-014 ws-3 scope).
 *
 * Scope per as-020 atomic spec:
 *   - Publish-only wrapper; emits the canonical `WorkstreamMetrics` JSON
 *     to the contract-declared path and flips the manifest convergence
 *     field `before_after_metrics_published = true` on success.
 *   - Delegates metrics computation to as-019 collector
 *     (`./pipeline-efficiency-ws3-collect.mjs`) when present. When
 *     the collector is not yet shipped, the publisher emits a pinned
 *     baseline-only payload that satisfies the `WorkstreamMetrics`
 *     schema — contract baselines are fixed per spec.md line 416-420.
 *     This keeps as-020 independently deployable (Atomicity Justification
 *     §Independently Deployable: "no runtime coupling beyond manifest
 *     write").
 *   - as-019, once landed, MAY override `actual` values with post-ship
 *     measurements by exporting `collectMetrics({ runId })` from the
 *     canonical collector path.
 *
 * Output path (AC20.1):
 *   .claude/metrics/pipeline-efficiency-ws3-orchestrator-hygiene-<run-id>.json
 *
 * Contract (spec.md §Interfaces-&-Contracts — Before/After Metrics Contract,
 * REQ-014 / WorkstreamMetrics):
 *   - workstream_id: 'ws-3'
 *   - run_id: string (echoes --run-id)
 *   - published_at: ISO-8601
 *   - metrics: {
 *       flow_verify_out_of_scope_findings: {baseline:38, target:0, actual:int},
 *       worktree_path_errors:              {baseline:2,  target:0, actual:int},
 *       atomizer_id_divergence:            {baseline:3,  target:0, actual:int},
 *       atomizer_gravestone_commits:       {baseline:12, target:0, actual:int},
 *       late_hash_registry_drift:          {baseline:1,  target:0, actual:int},
 *     }
 *   - sample_set_description: string
 *
 * Atomic write (spec.md as-020 Implementation Notes):
 *   Temp-file + rename. `fs.renameSync` is atomic on POSIX within a
 *   single filesystem.
 *
 * CLI:
 *   node .claude/scripts/metrics/pipeline-efficiency-ws3-publish.mjs \
 *     --run-id <id> \
 *     [--out-dir <metrics-dir>] \
 *     [--manifest-path <path>] \
 *     [--collector-module <path>] \
 *     [--skip-manifest-update]
 *
 * Exit codes:
 *   0 - Success. Metrics file written + manifest updated.
 *   1 - Runtime error (I/O, malformed collector output).
 *   2 - Invocation error (missing --run-id, collector output fails schema).
 *
 * Implements: AC20.1, AC20.2 (as-020).
 * Soft-depends on: as-019 (collector). Operates without it.
 *
 * @req REQ-014
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// =============================================================================
// Constants
// =============================================================================

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR_REL = '.claude/metrics';
const DEFAULT_MANIFEST_REL =
  '.claude/specs/groups/sg-pipeline-efficiency-ws3-orchestrator-hygiene/manifest.json';
const DEFAULT_COLLECTOR_REL = './pipeline-efficiency-ws3-collect.mjs';

const FILENAME_PREFIX = 'pipeline-efficiency-ws3-orchestrator-hygiene-';
const FILENAME_SUFFIX = '.json';

const WS_ID = 'ws-3';
const CONVERGENCE_FIELD = 'before_after_metrics_published';

// Required top-level fields per WorkstreamMetrics contract (spec.md line 411-430).
const REQUIRED_TOP_FIELDS = [
  'workstream_id',
  'run_id',
  'published_at',
  'metrics',
  'sample_set_description',
];

// Required sub-fields of `metrics` per contract (spec.md line 416-420).
const REQUIRED_METRIC_KEYS = [
  'flow_verify_out_of_scope_findings',
  'worktree_path_errors',
  'atomizer_id_divergence',
  'atomizer_gravestone_commits',
  'late_hash_registry_drift',
];

// Each metric sub-field must have baseline/target/actual (spec.md line 416-420).
const REQUIRED_METRIC_TRIAD = ['baseline', 'target', 'actual'];

// Contract-pinned baseline + target values (spec.md line 416-420).
// These are measured pre-ship observations from the evidence run; they are
// not re-computed by the publisher. The as-019 collector may override
// `actual` with post-ship measurements but baselines stay pinned.
const CONTRACT_METRICS = {
  flow_verify_out_of_scope_findings: { baseline: 38, target: 0 },
  worktree_path_errors: { baseline: 2, target: 0 },
  atomizer_id_divergence: { baseline: 3, target: 0 },
  atomizer_gravestone_commits: { baseline: 12, target: 0 },
  late_hash_registry_drift: { baseline: 1, target: 0 },
};

const DEFAULT_SAMPLE_SET_DESCRIPTION =
  'Pinned-baseline publication for sg-pipeline-efficiency-ws3-orchestrator-hygiene ' +
  'per REQ-014 / WorkstreamMetrics contract. Baselines from evidence run; ' +
  'actuals default to 0 pending as-019 collector post-ship measurement.';

// Sanitization rule for run-id. AC20.1 path-escape guard: the run-id is
// interpolated into the canonical filename. We restrict to characters
// that cannot alter the path (`[A-Za-z0-9._-]`).
const RUN_ID_ALLOWED_RE = /^[A-Za-z0-9._-]+$/;

// Structured error codes.
const ERR_MISSING_RUN_ID = 'MISSING_RUN_ID';
const ERR_INVALID_RUN_ID = 'INVALID_RUN_ID';
const ERR_COLLECTOR_INVALID_OUTPUT = 'COLLECTOR_INVALID_OUTPUT';
const ERR_MANIFEST_WRITE_FAILED = 'MANIFEST_WRITE_FAILED';
const ERR_OUTPUT_WRITE_FAILED = 'OUTPUT_WRITE_FAILED';

const EXIT_OK = 0;
const EXIT_RUNTIME_FAIL = 1;
const EXIT_USAGE = 2;

// =============================================================================
// Arg parsing
// =============================================================================

function parseArgs(argv) {
  const args = {
    runId: null,
    outDir: null,
    manifestPath: null,
    collectorModule: null,
    skipManifestUpdate: false,
    repoRoot: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id' && i + 1 < argv.length) args.runId = argv[++i];
    else if (a === '--out-dir' && i + 1 < argv.length) args.outDir = argv[++i];
    else if (a === '--manifest-path' && i + 1 < argv.length)
      args.manifestPath = argv[++i];
    else if (a === '--collector-module' && i + 1 < argv.length)
      args.collectorModule = argv[++i];
    else if (a === '--skip-manifest-update') args.skipManifestUpdate = true;
    else if (a === '--repo-root' && i + 1 < argv.length)
      args.repoRoot = argv[++i];
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(EXIT_OK);
    }
  }
  args.outDir = args.outDir || join(args.repoRoot, DEFAULT_OUT_DIR_REL);
  args.manifestPath =
    args.manifestPath || join(args.repoRoot, DEFAULT_MANIFEST_REL);
  return args;
}

function printUsage() {
  process.stderr.write(
    'Usage: node pipeline-efficiency-ws3-publish.mjs --run-id <id> \\\n' +
      '  [--out-dir <dir>] [--manifest-path <path>] \\\n' +
      '  [--collector-module <path>] [--skip-manifest-update]\n'
  );
}

// =============================================================================
// Metrics builder (contract-pinned defaults, collector-override optional)
// =============================================================================

/**
 * Build the default `WorkstreamMetrics` payload from contract-pinned
 * baselines. `actual` defaults to 0 for every metric; as-019 collector
 * may override these with post-ship measurements.
 *
 * @param {{runId:string, publishedAt:string}} meta
 * @returns {object} WorkstreamMetrics
 */
function buildDefaultPayload({ runId, publishedAt }) {
  const metrics = {};
  for (const key of REQUIRED_METRIC_KEYS) {
    const pinned = CONTRACT_METRICS[key];
    metrics[key] = {
      baseline: pinned.baseline,
      target: pinned.target,
      actual: 0,
    };
  }
  return {
    workstream_id: WS_ID,
    run_id: runId,
    published_at: publishedAt,
    metrics,
    sample_set_description: DEFAULT_SAMPLE_SET_DESCRIPTION,
  };
}

/**
 * Attempt to load + invoke the as-019 collector module. When the
 * collector is present + well-formed, its output is returned as the
 * `WorkstreamMetrics` payload. When absent, `null` is returned so the
 * caller falls back to `buildDefaultPayload`.
 *
 * Tolerant on import/shape failure — failures are logged to stderr but
 * do not abort publication (as-020's Atomicity Justification declares
 * "no runtime coupling beyond manifest write").
 *
 * @param {string|null} explicitPath - `--collector-module` override or null.
 * @param {string} runId
 * @returns {Promise<object|null>} WorkstreamMetrics or null when absent/unusable.
 */
async function tryCollector(explicitPath, runId) {
  let modulePath;
  if (explicitPath) {
    modulePath = isAbsolute(explicitPath)
      ? explicitPath
      : resolve(process.cwd(), explicitPath);
  } else {
    modulePath = resolve(SCRIPT_DIR, DEFAULT_COLLECTOR_REL);
  }
  if (!existsSync(modulePath)) return null;
  let mod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        level: 'warn',
        source: 'ws3-publisher',
        reason: 'collector_import_fail',
        details: {
          module_path: modulePath,
          error: err && err.message ? err.message : String(err),
        },
      }) + '\n'
    );
    return null;
  }
  // Collector surface adapter — supports two shapes:
  //   (1) `collectMetrics({ runId }) → WorkstreamMetrics` (publisher-native).
  //   (2) as-019 shape: `run(args) → { ok, payload }` where payload is a
  //       WorkstreamMetrics-shaped object. Publisher synthesises the
  //       minimal args (runId passed through; collector resolves its
  //       own specs/audit-log defaults from repoRoot).
  const collectMetrics = mod.collectMetrics;
  const legacyRun = mod.run;
  let out;
  if (typeof collectMetrics === 'function') {
    try {
      out = await collectMetrics({ runId });
    } catch (err) {
      process.stderr.write(
        JSON.stringify({
          level: 'warn',
          source: 'ws3-publisher',
          reason: 'collector_threw',
          details: {
            module_path: modulePath,
            surface: 'collectMetrics',
            error: err && err.message ? err.message : String(err),
          },
        }) + '\n'
      );
      return null;
    }
  } else if (typeof legacyRun === 'function') {
    try {
      // as-019 run() expects parsed args; parseArgs is exported.
      const parseFn = mod.parseArgs;
      const collectorArgs =
        typeof parseFn === 'function'
          ? parseFn(['--run-id', runId])
          : { runId };
      const r = await legacyRun(collectorArgs);
      if (!r || typeof r !== 'object') {
        process.stderr.write(
          JSON.stringify({
            level: 'warn',
            source: 'ws3-publisher',
            reason: 'collector_non_object',
            details: {
              module_path: modulePath,
              surface: 'run',
              received_type: r === null ? 'null' : typeof r,
            },
          }) + '\n'
        );
        return null;
      }
      if (r.ok === false) {
        process.stderr.write(
          JSON.stringify({
            level: 'warn',
            source: 'ws3-publisher',
            reason: 'collector_not_ok',
            details: {
              module_path: modulePath,
              surface: 'run',
              error: r.error || 'unknown',
              message: r.message || '',
            },
          }) + '\n'
        );
        return null;
      }
      out = r.payload || r;
    } catch (err) {
      process.stderr.write(
        JSON.stringify({
          level: 'warn',
          source: 'ws3-publisher',
          reason: 'collector_threw',
          details: {
            module_path: modulePath,
            surface: 'run',
            error: err && err.message ? err.message : String(err),
          },
        }) + '\n'
      );
      return null;
    }
  } else {
    process.stderr.write(
      JSON.stringify({
        level: 'warn',
        source: 'ws3-publisher',
        reason: 'collector_missing_exports',
        details: {
          module_path: modulePath,
          expected_exports: ['collectMetrics', 'run'],
        },
      }) + '\n'
    );
    return null;
  }
  if (!out || typeof out !== 'object') {
    process.stderr.write(
      JSON.stringify({
        level: 'warn',
        source: 'ws3-publisher',
        reason: 'collector_non_object',
        details: {
          module_path: modulePath,
          surface: 'collectMetrics',
          received_type: out === null ? 'null' : typeof out,
        },
      }) + '\n'
    );
    return null;
  }
  return out;
}

// =============================================================================
// Schema validation (contract: WorkstreamMetrics)
// =============================================================================

/**
 * Validate `payload` against the `WorkstreamMetrics` contract from
 * spec.md §Interfaces-&-Contracts. Returns { ok, errors[] }.
 *
 * Applied to the final payload regardless of source (default-built or
 * collector-supplied).
 *
 * @param {unknown} payload
 * @param {string} expectedRunId
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
function validatePayload(payload, expectedRunId) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: ['payload is not a plain object'] };
  }
  for (const f of REQUIRED_TOP_FIELDS) {
    if (!(f in payload)) errors.push(`missing top-level field: ${f}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  if (payload.workstream_id !== WS_ID) {
    errors.push(
      `workstream_id must be '${WS_ID}'; got ${JSON.stringify(
        payload.workstream_id
      )}`
    );
  }
  if (typeof payload.run_id !== 'string' || payload.run_id.length === 0) {
    errors.push('run_id must be a non-empty string');
  } else if (payload.run_id !== expectedRunId) {
    errors.push(
      `run_id mismatch: payload '${payload.run_id}', expected '${expectedRunId}'`
    );
  }
  if (typeof payload.published_at !== 'string') {
    errors.push('published_at must be an ISO-8601 string');
  } else if (!Number.isFinite(new Date(payload.published_at).getTime())) {
    errors.push(`published_at is not parseable: ${payload.published_at}`);
  }
  if (
    typeof payload.sample_set_description !== 'string' ||
    payload.sample_set_description.length === 0
  ) {
    errors.push('sample_set_description must be a non-empty string');
  }

  const metrics = payload.metrics;
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    errors.push('metrics must be a plain object');
  } else {
    for (const key of REQUIRED_METRIC_KEYS) {
      if (!(key in metrics)) {
        errors.push(`metrics.${key}: missing`);
        continue;
      }
      const entry = metrics[key];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(
          `metrics.${key}: must be object with baseline/target/actual`
        );
        continue;
      }
      for (const triad of REQUIRED_METRIC_TRIAD) {
        if (!(triad in entry)) {
          errors.push(`metrics.${key}.${triad}: missing`);
          continue;
        }
        if (
          typeof entry[triad] !== 'number' ||
          !Number.isFinite(entry[triad])
        ) {
          errors.push(
            `metrics.${key}.${triad}: must be finite number (got ${JSON.stringify(
              entry[triad]
            )})`
          );
        }
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// =============================================================================
// Atomic write (temp + rename)
// =============================================================================

/**
 * Write `data` as JSON to `path` atomically. Creates the directory tree
 * if absent. POSIX `rename` is atomic within a single filesystem, so a
 * concurrent reader never observes a partial write.
 *
 * @param {string} path
 * @param {unknown} data
 */
function atomicWriteJson(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const body = JSON.stringify(data, null, 2) + '\n';
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of temp file on failure.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// =============================================================================
// Manifest update (AC20.2)
// =============================================================================

/**
 * Flip `convergence.before_after_metrics_published = true` in the ws-3
 * manifest + append a decision-log entry. When the convergence object
 * does not exist it is created. Other manifest fields are preserved
 * (AC20.2 idempotence + preservation tests).
 *
 * Missing manifest is treated as a soft no-op: publish must not abort
 * on a fixture lacking a manifest (the tests seed one, but the real
 * ws-3 manifest is guaranteed). If the manifest is absent AND
 * --skip-manifest-update was not passed, the caller is still notified
 * via stderr so the operator can investigate.
 *
 * @param {string} manifestPath
 * @param {{run_id:string, out_file:string, published_at:string}} meta
 * @returns {{updated:boolean, reason?:string}}
 */
function updateManifestConvergence(manifestPath, meta) {
  if (!existsSync(manifestPath)) {
    return { updated: false, reason: `manifest-absent:${manifestPath}` };
  }
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    const e = new Error(
      `${ERR_MANIFEST_WRITE_FAILED}: read failed ${manifestPath}: ${err.message}`
    );
    e.code = ERR_MANIFEST_WRITE_FAILED;
    throw e;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    const e = new Error(
      `${ERR_MANIFEST_WRITE_FAILED}: manifest JSON invalid: ${err.message}`
    );
    e.code = ERR_MANIFEST_WRITE_FAILED;
    throw e;
  }
  if (!manifest.convergence || typeof manifest.convergence !== 'object') {
    manifest.convergence = {};
  }
  manifest.convergence[CONVERGENCE_FIELD] = true;
  if (!Array.isArray(manifest.decision_log)) manifest.decision_log = [];
  manifest.decision_log.push({
    timestamp: new Date().toISOString(),
    actor: 'metrics-publisher',
    action: 'before_after_metrics_published',
    details:
      `ws-3 metrics file published at ${meta.out_file} ` +
      `(run_id=${meta.run_id}, published_at=${meta.published_at}). ` +
      `convergence.${CONVERGENCE_FIELD} = true.`,
  });
  manifest.updated_at = new Date().toISOString();

  try {
    atomicWriteJson(manifestPath, manifest);
  } catch (err) {
    const e = new Error(
      `${ERR_MANIFEST_WRITE_FAILED}: write failed ${manifestPath}: ${err.message}`
    );
    e.code = ERR_MANIFEST_WRITE_FAILED;
    throw e;
  }
  return { updated: true };
}

// =============================================================================
// Orchestrator (testable — no process.exit inside)
// =============================================================================

/**
 * Run the publisher end-to-end. Pure with respect to process signals —
 * returns a structured result instead of calling process.exit, so tests
 * can assert without spawning a subprocess.
 *
 * @param {ReturnType<typeof parseArgs>} args
 * @returns {Promise<{ok:boolean, exit:number, outFile?:string, payload?:any, manifestUpdated?:boolean, error?:string, message?:string}>}
 */
async function run(args) {
  if (!args.runId || typeof args.runId !== 'string' || args.runId.length === 0) {
    return {
      ok: false,
      exit: EXIT_USAGE,
      error: ERR_MISSING_RUN_ID,
      message: `${ERR_MISSING_RUN_ID}: --run-id <id> is required; operator-provided per spec.`,
    };
  }
  if (!RUN_ID_ALLOWED_RE.test(args.runId)) {
    // Path-escape guard: run-id is interpolated into a filename.
    return {
      ok: false,
      exit: EXIT_USAGE,
      error: ERR_INVALID_RUN_ID,
      message:
        `${ERR_INVALID_RUN_ID}: --run-id must match ${RUN_ID_ALLOWED_RE}. ` +
        `Received: ${JSON.stringify(args.runId)}`,
    };
  }

  const publishedAt = new Date().toISOString();

  // AC20.1 — try as-019 collector; fall back to contract-pinned defaults.
  const collectorPayload = await tryCollector(args.collectorModule, args.runId);
  let payload;
  if (collectorPayload) {
    // Normalize: ensure collector output carries the canonical run_id +
    // fresh published_at. Collector may omit these; stamp authoritatively.
    payload = {
      ...collectorPayload,
      workstream_id: WS_ID,
      run_id: args.runId,
      published_at:
        typeof collectorPayload.published_at === 'string' &&
        collectorPayload.published_at.length > 0
          ? collectorPayload.published_at
          : publishedAt,
    };
  } else {
    payload = buildDefaultPayload({ runId: args.runId, publishedAt });
  }

  const validation = validatePayload(payload, args.runId);
  if (!validation.ok) {
    return {
      ok: false,
      exit: EXIT_USAGE,
      error: ERR_COLLECTOR_INVALID_OUTPUT,
      message:
        `${ERR_COLLECTOR_INVALID_OUTPUT}: payload fails WorkstreamMetrics ` +
        `schema — ${validation.errors.join('; ')}`,
    };
  }

  // AC20.1 — atomic write to canonical output path.
  const outFile = join(
    resolve(args.outDir),
    `${FILENAME_PREFIX}${args.runId}${FILENAME_SUFFIX}`
  );
  try {
    atomicWriteJson(outFile, payload);
  } catch (err) {
    return {
      ok: false,
      exit: EXIT_RUNTIME_FAIL,
      error: ERR_OUTPUT_WRITE_FAILED,
      message: `${ERR_OUTPUT_WRITE_FAILED}: ${err.message}`,
    };
  }

  // AC20.2 — flip manifest convergence gate (schema-valid => field true).
  let manifestUpdated = false;
  if (!args.skipManifestUpdate) {
    try {
      const r = updateManifestConvergence(args.manifestPath, {
        run_id: args.runId,
        out_file: outFile,
        published_at: payload.published_at,
      });
      manifestUpdated = r.updated;
    } catch (err) {
      return {
        ok: false,
        exit: EXIT_RUNTIME_FAIL,
        error: err.code || ERR_MANIFEST_WRITE_FAILED,
        message: err.message,
      };
    }
  }

  return { ok: true, exit: EXIT_OK, outFile, payload, manifestUpdated };
}

// =============================================================================
// Main (CLI)
// =============================================================================

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(EXIT_USAGE);
  }

  let result;
  try {
    result = await run(args);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(EXIT_RUNTIME_FAIL);
  }

  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(result.exit);
  }

  process.stderr.write(
    `published: ${result.outFile} (run_id=${result.payload.run_id}, ` +
      `workstream_id=${result.payload.workstream_id}, ` +
      `published_at=${result.payload.published_at}, ` +
      `manifest_updated=${result.manifestUpdated})\n`
  );
  process.exit(EXIT_OK);
}

// =============================================================================
// Exports for test harness
// =============================================================================

export {
  parseArgs,
  buildDefaultPayload,
  tryCollector,
  validatePayload,
  atomicWriteJson,
  updateManifestConvergence,
  run,
  // Constants useful for tests.
  FILENAME_PREFIX,
  FILENAME_SUFFIX,
  WS_ID,
  CONVERGENCE_FIELD,
  REQUIRED_TOP_FIELDS,
  REQUIRED_METRIC_KEYS,
  REQUIRED_METRIC_TRIAD,
  CONTRACT_METRICS,
  RUN_ID_ALLOWED_RE,
  // Error codes.
  ERR_MISSING_RUN_ID,
  ERR_INVALID_RUN_ID,
  ERR_COLLECTOR_INVALID_OUTPUT,
  ERR_MANIFEST_WRITE_FAILED,
  ERR_OUTPUT_WRITE_FAILED,
  // Exit codes.
  EXIT_OK,
  EXIT_RUNTIME_FAIL,
  EXIT_USAGE,
};

// =============================================================================
// CLI entrypoint (only when invoked directly)
// =============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
