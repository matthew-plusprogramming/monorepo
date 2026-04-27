#!/usr/bin/env node

/**
 * test-baseline-check: run the test suite, diff failures against
 * `.claude/test-baseline.json`, and emit a structured JSON summary to
 * stdout.
 *
 * Test-baseline regression-check contract.
 * Covers ACs:
 *   - AC1.1: stdout JSON `{new_failures, fixed_failures}` via exact-tuple match.
 *   - AC1.2: exit non-zero when `new_failures.length > 0`; zero otherwise.
 *   - AC1.3: baseline absent -> warning + exit 0 (graceful degradation).
 *   - AC1.4: baseline corrupt -> fail-closed via schema validator.
 *   - AC1.5 (DEC-CHK-002): `--bootstrap` mode generates baseline from current
 *     failures when absent; exits 0.
 *   - AC1.6 (DEC-CHK-010): `--refresh` mode re-runs suite, removes now-passing
 *     entries (logged `fixed-by-remediation`), adds new regressions (logged
 *     `new-post-remediation`), appends summary, writes atomically, exits 0.
 *
 * Invocation (via `npm run test:baseline`):
 *   node .claude/scripts/test-baseline-check.mjs            # default check
 *   node .claude/scripts/test-baseline-check.mjs --bootstrap
 *   node .claude/scripts/test-baseline-check.mjs --refresh
 *
 * Exit codes:
 *   0   OK (no new failures, or graceful-degradation, or bootstrap success,
 *       or refresh success).
 *   1   Regressions detected (new_failures.length > 0).
 *   2   Fail-closed: corrupt baseline JSON, unknown version, or schema
 *       violation.
 *   3   Argument / mode misuse (e.g., --refresh with absent baseline).
 *   4   Test runner / subprocess failure (vitest crashed before reporting).
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteSentinel } from './lib/atomic-write.mjs';
import { getCanonicalProjectDir } from './lib/hook-utils.mjs';
import {
  SUPPORTED_VERSION,
  TestBaselineError,
  entryKey,
  formatRefreshLogLine,
  loadBaselineFile,
} from './lib/test-baseline-schema.mjs';
import {
  diffFailures,
  extractFailingTuples,
  extractTotals,
  resolveRepoRoot,
  runVitestJson,
} from './lib/test-run.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// Paths
// =============================================================================

/**
 * Resolve the project root for baseline paths. When `CLAUDE_PROJECT_DIR` is
 * set, defer to `getCanonicalProjectDir()` (the SOLE authorized reader of the
 * env var per AS-012) for symlink-resolution + containment checks. When the
 * env var is absent (operator running the CLI directly without hook context),
 * fall back to the script-relative repo root.
 */
function resolveProjectDir() {
  try {
    return getCanonicalProjectDir();
  } catch {
    // CanonicalProjectDirError thrown when env is absent / unresolved; the
    // CLI is usable standalone, so fall back to the repo root derived from
    // this script's location.
    return resolveRepoRoot();
  }
}

function defaultBaselinePath() {
  return resolve(resolveProjectDir(), '.claude', 'test-baseline.json');
}

function defaultRefreshLogPath() {
  return resolve(resolveProjectDir(), '.claude', 'test-baseline.refresh-log.jsonl');
}

// =============================================================================
// CLI parsing
// =============================================================================

/**
 * Parse CLI flags. Supports `--bootstrap`, `--refresh`, `--baseline=<path>`,
 * `--help` / `-h`, and the environment override `BASELINE_CHECK_REPORT_JSON`
 * for tests that want to short-circuit the vitest subprocess with a pre-
 * computed report.
 */
export function parseArgs(argv) {
  const args = {
    bootstrap: false,
    refresh: false,
    baselinePath: null,
    refreshLogPath: null,
    failuresFixture: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bootstrap') args.bootstrap = true;
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--baseline=')) args.baselinePath = a.slice('--baseline='.length);
    else if (a.startsWith('--refresh-log=')) args.refreshLogPath = a.slice('--refresh-log='.length);
    else if (a === '--failures-fixture') {
      if (i + 1 >= argv.length) {
        throw new TestBaselineError('--failures-fixture requires a path', 'arg_misuse');
      }
      args.failuresFixture = argv[++i];
    } else if (a.startsWith('--failures-fixture=')) {
      args.failuresFixture = a.slice('--failures-fixture='.length);
    } else {
      throw new TestBaselineError(`unknown flag: ${a}`, 'arg_misuse');
    }
  }
  if (args.bootstrap && args.refresh) {
    throw new TestBaselineError(
      '--bootstrap and --refresh are mutually exclusive',
      'arg_misuse',
    );
  }
  return args;
}

function printHelp(stream = process.stdout) {
  stream.write(
    [
      'Usage: test-baseline-check [--bootstrap | --refresh] [--baseline=<path>]',
      '',
      'Default mode:',
      '  Runs `npm test` via vitest, diffs failures against .claude/test-baseline.json,',
      '  emits {new_failures, fixed_failures} JSON to stdout, and exits non-zero when',
      '  new_failures is non-empty.',
      '',
      'Modes:',
      '  --bootstrap  Generate the baseline from current failures when the file is',
      '               absent. Exits 0 after writing.',
      '  --refresh    Re-run suite, recompute baseline: remove now-passing entries,',
      '               add new regressions, append summary to the refresh log.',
      '               Exits 0 on success.',
      '',
      'Exit codes:',
      '  0  OK (including graceful degradation and bootstrap success)',
      '  1  Regressions detected',
      '  2  Fail-closed (corrupt baseline / unknown version / schema violation)',
      '  3  Argument / mode misuse',
      '  4  Test runner failure',
    ].join('\n') + '\n',
  );
}

// =============================================================================
// Runner hook (overrideable for tests)
// =============================================================================

/**
 * Obtain the current-failure report. Three sources in precedence order:
 *
 * 1. `--failures-fixture <path>` — a JSON array of `{file, test}` tuples.
 *    This is the hermetic seam used by the test-writer harness; it avoids
 *    spawning a real vitest subprocess.
 * 2. `BASELINE_CHECK_REPORT_JSON` env var — a vitest JSON reporter file.
 *    Legacy seam kept for internal unit tests.
 * 3. Real vitest subprocess via `runVitestJson`.
 *
 * Returns the shape `{ tuples: Array<{file,test}>, totals, exitCode? }`.
 */
export function obtainCurrentFailures(opts = {}) {
  // --failures-fixture seam (test-writer contract)
  if (opts.failuresFixture) {
    if (!existsSync(opts.failuresFixture)) {
      throw new Error(`--failures-fixture points to missing file: ${opts.failuresFixture}`);
    }
    const tuples = JSON.parse(readFileSync(opts.failuresFixture, 'utf8'));
    if (!Array.isArray(tuples)) {
      throw new Error('--failures-fixture must be a JSON array of {file, test} tuples');
    }
    return {
      report: null,
      tuples,
      totals: {
        pass: 0,
        fail: tuples.length,
        skip: 0,
        total: tuples.length,
      },
    };
  }

  // BASELINE_CHECK_REPORT_JSON seam (internal)
  const envOverride = process.env.BASELINE_CHECK_REPORT_JSON;
  if (envOverride) {
    if (!existsSync(envOverride)) {
      throw new Error(`BASELINE_CHECK_REPORT_JSON points to missing file: ${envOverride}`);
    }
    const report = JSON.parse(readFileSync(envOverride, 'utf8'));
    return {
      report,
      tuples: extractFailingTuples(report, { repoRoot: resolveRepoRoot() }),
      totals: extractTotals(report),
    };
  }

  // Real vitest subprocess
  const { report, exitCode } = runVitestJson(opts);
  return {
    report,
    exitCode,
    tuples: extractFailingTuples(report, { repoRoot: resolveRepoRoot() }),
    totals: extractTotals(report),
  };
}

// =============================================================================
// Mode implementations
// =============================================================================

/**
 * Default-mode run. Returns a result object; the CLI main wraps this and
 * handles exit code translation.
 */
export function runCheckMode(args, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const baselinePath = args.baselinePath || defaultBaselinePath();

  // Load baseline (fail-closed on corrupt / unknown version / schema violation)
  let baseline;
  try {
    baseline = loadBaselineFile(baselinePath);
  } catch (err) {
    if (err instanceof TestBaselineError) {
      stderr.write(`[baseline-check] ERROR: ${err.message}\n`);
      return { exitCode: 2 };
    }
    throw err;
  }

  // AC1.3 graceful degradation: baseline absent -> warning + exit 0.
  if (baseline === null) {
    stderr.write(
      `[baseline-check] WARNING: baseline file ${baselinePath} not found; skipping regression check. ` +
        `Run with --bootstrap to initialize.\n`,
    );
    return { exitCode: 0 };
  }

  // Run test suite (or read override report)
  let current;
  try {
    current = obtainCurrentFailures({ failuresFixture: args.failuresFixture });
  } catch (err) {
    stderr.write(`[baseline-check] ERROR: test runner failed: ${err.message}\n`);
    return { exitCode: 4 };
  }

  const diff = diffFailures(current.tuples, baseline.entries);

  // Emit diff JSON to stdout (AC1.1)
  const output = {
    new_failures: diff.new_failures,
    fixed_failures: diff.fixed_failures.map((e) => ({ file: e.file, test: e.test })),
    totals: current.totals,
    baseline_entry_count: baseline.entries.length,
  };
  stdout.write(JSON.stringify(output, null, 2) + '\n');

  // AC1.2 exit codes
  return { exitCode: diff.new_failures.length > 0 ? 1 : 0, diff, output };
}

/**
 * Bootstrap mode: baseline absent + `--bootstrap` -> generate baseline from
 * current failures (AC1.5 / DEC-CHK-002).
 *
 * If the baseline already exists, bootstrap is a no-op misuse — we emit a
 * clear stderr error and exit 3. The operator must delete or move the
 * existing baseline first.
 */
export function runBootstrapMode(args, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const baselinePath = args.baselinePath || defaultBaselinePath();

  if (existsSync(baselinePath)) {
    stderr.write(
      `[baseline-check] ERROR: --bootstrap requires absent baseline file; ${baselinePath} already exists. ` +
        `Remove it first or use --refresh to recompute in place.\n`,
    );
    return { exitCode: 3 };
  }

  let current;
  try {
    current = obtainCurrentFailures({ failuresFixture: args.failuresFixture });
  } catch (err) {
    stderr.write(`[baseline-check] ERROR: test runner failed: ${err.message}\n`);
    return { exitCode: 4 };
  }

  const now = new Date().toISOString();
  const entries = current.tuples
    .map((t) => ({
      file: t.file,
      test: t.test,
      reason: 'inherited-baseline',
      added_date: now,
    }))
    // Sort for deterministic output so repeated bootstraps are byte-stable
    // when failures don't change.
    .sort((a, b) => entryKey(a).localeCompare(entryKey(b)));

  const doc = { version: SUPPORTED_VERSION, entries };
  const ok = atomicWriteSentinel(baselinePath, JSON.stringify(doc, null, 2) + '\n');
  if (!ok) {
    stderr.write(`[baseline-check] ERROR: atomic write failed for ${baselinePath}\n`);
    return { exitCode: 4 };
  }

  stdout.write(
    JSON.stringify(
      {
        mode: 'bootstrap',
        baseline_path: baselinePath,
        entry_count: entries.length,
        totals: current.totals,
      },
      null,
      2,
    ) + '\n',
  );
  return { exitCode: 0 };
}

/**
 * Refresh mode: baseline present + `--refresh` -> re-run suite, remove now-
 * passing entries, add new regressions, append refresh-log records, exit 0
 * (AC1.6 / DEC-CHK-010).
 */
export function runRefreshMode(args, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const baselinePath = args.baselinePath || defaultBaselinePath();
  const refreshLogPath = args.refreshLogPath || defaultRefreshLogPath();

  // --refresh with absent baseline -> clear misuse error (per spec task list).
  if (!existsSync(baselinePath)) {
    stderr.write(
      `[baseline-check] ERROR: baseline absent; use --bootstrap to initialize (${baselinePath})\n`,
    );
    return { exitCode: 3 };
  }

  // Load the existing baseline (fail-closed on corruption).
  let baseline;
  try {
    baseline = loadBaselineFile(baselinePath);
  } catch (err) {
    if (err instanceof TestBaselineError) {
      stderr.write(`[baseline-check] ERROR: ${err.message}\n`);
      return { exitCode: 2 };
    }
    throw err;
  }

  // Run the suite
  let current;
  try {
    current = obtainCurrentFailures({ failuresFixture: args.failuresFixture });
  } catch (err) {
    stderr.write(`[baseline-check] ERROR: test runner failed: ${err.message}\n`);
    return { exitCode: 4 };
  }

  const currentKeys = new Set(current.tuples.map((t) => entryKey(t)));
  const baselineKeys = new Set(baseline.entries.map((e) => entryKey(e)));
  const now = new Date().toISOString();

  // Tests that flipped fail -> pass: remove from baseline, log removed.
  const removed = baseline.entries.filter((e) => !currentKeys.has(entryKey(e)));
  // Tests that flipped pass -> fail (new regressions): add to baseline, log added.
  const added = current.tuples.filter((t) => !baselineKeys.has(entryKey(t)));

  const preCount = baseline.entries.length;
  const keptEntries = baseline.entries.filter((e) => currentKeys.has(entryKey(e)));
  const newEntries = added.map((t) => ({
    file: t.file,
    test: t.test,
    reason: 'new-post-remediation',
    added_date: now,
  }));
  const merged = [...keptEntries, ...newEntries].sort((a, b) =>
    entryKey(a).localeCompare(entryKey(b)),
  );
  const postCount = merged.length;

  // Append per-entry refresh-log records (atomic individual appends are safe
  // because the log is append-only JSONL).
  const logLines = [];
  for (const r of removed) {
    logLines.push(
      formatRefreshLogLine({
        action: 'removed',
        file: r.file,
        test: r.test,
        reason: 'fixed-by-remediation',
        refresh_date: now,
      }),
    );
  }
  for (const a of added) {
    logLines.push(
      formatRefreshLogLine({
        action: 'added',
        file: a.file,
        test: a.test,
        reason: 'new-post-remediation',
        refresh_date: now,
      }),
    );
  }
  // Summary line
  logLines.push(
    formatRefreshLogLine({
      action: 'summary',
      refresh_date: now,
      removed_count: removed.length,
      added_count: added.length,
      pre_refresh_entry_count: preCount,
      post_refresh_entry_count: postCount,
    }),
  );

  // Write updated baseline atomically
  const doc = { version: SUPPORTED_VERSION, entries: merged };
  const ok = atomicWriteSentinel(baselinePath, JSON.stringify(doc, null, 2) + '\n');
  if (!ok) {
    stderr.write(`[baseline-check] ERROR: atomic write failed for ${baselinePath}\n`);
    return { exitCode: 4 };
  }

  // Append log lines after baseline write succeeds (order: baseline first so
  // a failure during logging still leaves the baseline consistent).
  try {
    appendFileSync(refreshLogPath, logLines.join(''));
  } catch (err) {
    stderr.write(`[baseline-check] ERROR: refresh-log append failed: ${err.message}\n`);
    return { exitCode: 4 };
  }

  stdout.write(
    JSON.stringify(
      {
        mode: 'refresh',
        baseline_path: baselinePath,
        refresh_log_path: refreshLogPath,
        removed_count: removed.length,
        added_count: added.length,
        pre_refresh_entry_count: preCount,
        post_refresh_entry_count: postCount,
        totals: current.totals,
      },
      null,
      2,
    ) + '\n',
  );

  return { exitCode: 0 };
}

// =============================================================================
// Main
// =============================================================================

export function main(argv = process.argv.slice(2), io = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    (io.stderr || process.stderr).write(`[baseline-check] ERROR: ${err.message}\n`);
    printHelp(io.stderr || process.stderr);
    return 3;
  }

  if (args.help) {
    printHelp(io.stdout || process.stdout);
    return 0;
  }

  if (args.bootstrap) return runBootstrapMode(args, io).exitCode;
  if (args.refresh) return runRefreshMode(args, io).exitCode;
  return runCheckMode(args, io).exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = main();
  // exit after an event-loop tick so streams flush before process ends
  process.exit(code);
}
