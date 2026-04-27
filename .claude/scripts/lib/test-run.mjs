/**
 * Test run orchestrator: spawn `npm test` via vitest JSON reporter and
 * reduce the output to `(file, test)` tuples used by the baseline pipeline.
 *
 * Shared between `.claude/scripts/test-baseline-check.mjs` (as-022) and
 * `.claude/scripts/test-baseline-update.mjs` (as-023).
 *
 * Design notes:
 *   - We force vitest's JSON reporter via `--reporter=json` and direct it
 *     to a temp output file so stdout noise (trace generator warnings,
 *     progress output) does not contaminate the structured result.
 *   - `suite.name` in the JSON report is an absolute path on the executing
 *     host; we convert it to a repo-relative path so the baseline entries
 *     are portable across developer checkouts.
 *   - `assertionResults[i].fullName` is the canonical test name; we fall
 *     back to `title` for safety even though fullName has been stable since
 *     vitest 1.x.
 *
 * @req REQ-006
 * @contract test-baseline-runner
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Default vitest config path (canonical config for the repo). Exported so
 * tests can override in isolated environments.
 */
export const DEFAULT_VITEST_CONFIG = '.claude/scripts/vitest.config.mjs';

/**
 * Resolve the repo root from the lib file location. We sit two levels deep
 * (`.claude/scripts/lib/`), so `../../../` is the repo root.
 */
export function resolveRepoRoot() {
  return resolve(__dirname, '..', '..', '..');
}

/**
 * Convert an absolute file path into a repo-relative POSIX path. The vitest
 * JSON reporter emits absolute paths for each test suite; the baseline file
 * stores repo-relative paths so entries are portable across checkouts.
 */
export function toRepoRelative(absPath, repoRoot = resolveRepoRoot()) {
  const rel = relative(repoRoot, absPath);
  // Normalize Windows separators if the script is ever ported. On POSIX this
  // is a no-op.
  return rel.split(sep).join('/');
}

/**
 * Execute `npx vitest run --reporter=json` and return the parsed JSON report.
 *
 * The vitest JSON reporter prints JSON to stdout by default, which gets mixed
 * with other framework log lines. We instead direct the reporter to write to
 * a temp file via `--outputFile=...` and read it back. This is the same
 * pattern used by the reference baseline at `sg-enforcement-layer-gaps`.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]          Working directory (default: repoRoot).
 * @param {string} [opts.configPath]   Config path relative to cwd (default: DEFAULT_VITEST_CONFIG).
 * @param {number} [opts.timeoutMs]    Process timeout (default: 20 minutes).
 * @returns {{ report: object, exitCode: number }}
 */
export function runVitestJson(opts = {}) {
  const repoRoot = resolveRepoRoot();
  const cwd = opts.cwd || repoRoot;
  const configPath = opts.configPath || DEFAULT_VITEST_CONFIG;
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;

  const tmp = mkdtempSync(resolve(tmpdir(), 'baseline-check-'));
  const outFile = resolve(tmp, 'vitest-report.json');

  try {
    const result = spawnSync(
      'npx',
      [
        'vitest',
        'run',
        '--config',
        configPath,
        '--reporter=json',
        `--outputFile=${outFile}`,
      ],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        // vitest inherits env + npm_config_*; keep minimal forwarding
        env: process.env,
      },
    );

    if (result.error) {
      throw new Error(`vitest spawn error: ${result.error.message}`);
    }

    let report;
    try {
      report = JSON.parse(readFileSync(outFile, 'utf8'));
    } catch (err) {
      // When vitest exits before reporting (e.g. config parse error), the
      // JSON file may be absent or truncated. Surface stderr to aid debugging.
      const stderr = (result.stderr || '').toString().slice(-2048);
      throw new Error(
        `vitest JSON report not parseable (${err.message}). Exit=${result.status}. Stderr tail:\n${stderr}`,
      );
    }

    return { report, exitCode: result.status ?? 0 };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Reduce a vitest JSON report to the `(file, test)` tuples for failing tests.
 *
 * @param {object} report              Parsed vitest JSON reporter output.
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]     Repo root used for path relativization.
 * @returns {Array<{file: string, test: string}>}
 */
export function extractFailingTuples(report, opts = {}) {
  const repoRoot = opts.repoRoot || resolveRepoRoot();
  const tuples = [];
  if (!report || !Array.isArray(report.testResults)) return tuples;
  for (const suite of report.testResults) {
    const fileRel = toRepoRelative(suite.name || '', repoRoot);
    if (!Array.isArray(suite.assertionResults)) continue;
    for (const a of suite.assertionResults) {
      if (a.status !== 'failed') continue;
      const test = a.fullName || a.title || '<unnamed>';
      tuples.push({ file: fileRel, test });
    }
  }
  return tuples;
}

/**
 * Extract the pass / fail / skip totals from a vitest JSON report.
 *
 * @param {object} report
 * @returns {{ pass: number, fail: number, skip: number, total: number }}
 */
export function extractTotals(report) {
  if (!report) return { pass: 0, fail: 0, skip: 0, total: 0 };
  return {
    pass: report.numPassedTests ?? 0,
    fail: report.numFailedTests ?? 0,
    skip: report.numPendingTests ?? 0,
    total: report.numTotalTests ?? 0,
  };
}

/**
 * Diff two sets of failing tuples. Each diff side is a list of tuples.
 *
 * `new_failures` = current \ baseline (tests failing now but not in baseline).
 * `fixed_failures` = baseline \ current (baseline entries whose test now passes).
 *
 * Exact-equality identity per `(file, test)` tuple (AC-022.1).
 */
export function diffFailures(currentTuples, baselineEntries) {
  const currentKeys = new Set(
    currentTuples.map((t) => `${t.file}\u0000${t.test}`),
  );
  const baselineKeys = new Set(
    baselineEntries.map((e) => `${e.file}\u0000${e.test}`),
  );

  const newFailures = currentTuples.filter(
    (t) => !baselineKeys.has(`${t.file}\u0000${t.test}`),
  );
  const fixedFailures = baselineEntries.filter(
    (e) => !currentKeys.has(`${e.file}\u0000${e.test}`),
  );

  return { new_failures: newFailures, fixed_failures: fixedFailures };
}
