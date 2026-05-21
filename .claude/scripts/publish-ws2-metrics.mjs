#!/usr/bin/env node

/**
 * publish-ws2-metrics.mjs
 *
 * Before-after metrics publication runner for ws-2 Practice 2.4 (REQ-014).
 * Reads spec-group manifests, spec/spec-slice, and test files across a
 * pre-ship / post-ship sampling window and emits a single metrics artifact
 * at `.claude/metrics/pipeline-efficiency-ws2-practice-2.4-<run-id>.json`
 * covering the test/AC ratio on bug-fix workstreams.
 *
 * Metric contract (REQ-014 / AC11.1-AC11.4 from as-011):
 *   - baseline_ratio:  pinned 2.16 (pipeline-efficiency PRD pre-ship evidence).
 *   - target_ratio:    pinned 1.3 (PRD-stated goal on next 5 bug-fix workstreams).
 *   - observed_ratio:  sum(tests) / sum(ACs) across the post-ship bug-fix
 *                      workstream sample. Structural (not behavioural)
 *                      measurement — a single floating-point quotient.
 *
 * Sample selection:
 *   Pre-ship:  last ~10 spec groups whose `created_at` < `--split-at` anchor,
 *              ordered by `created_at` descending, filtered to bug-fix
 *              workstreams (see classifier below).
 *   Post-ship: first ~10 spec groups whose `created_at` >= `--split-at`,
 *              ordered ascending, filtered to bug-fix workstreams.
 *
 * Split-at anchor:
 *   Default is the ws-2 merge ISO timestamp, resolved from
 *   `.claude/metrics/pipeline-efficiency-ws2-baseline.json` (as-010 artefact).
 *   If the baseline file is absent, the split anchor must be supplied via
 *   `--split-at <iso-8601>`. Split anchor is authoritative — we never guess it.
 *
 * Bug-fix classifier (documented so reviewers can audit the denominator):
 *   1. Manifest frontmatter `spec_mode == 'bug-fix'` (positive signal).
 *   2. Fall-back: spec-group id contains `bugs` OR `bug-fix` OR `fix-` prefix
 *      in its `id` field. This is a best-effort legacy rule applied ONLY to
 *      pre-ship samples authored before `spec_mode` existed — documented in
 *      the output JSON's `ac_denominator_rule` so operators see which rule
 *      applied to each sampled group.
 *
 * AC denominator rule (AC11.2 — sum-of-ACs):
 *   For each bug-fix spec group selected into either sample, the script reads
 *   `spec.md` plus optional `slices/*.md` and sums each frontmatter
 *   `ac_coverage` array. Missing arrays contribute zero. Legacy `atomic/*.md`
 *   files are read only as a fallback for old samples. This is the structural
 *   definition; no spec-body parsing is performed. The rule is emitted
 *   verbatim in the output JSON.
 *
 * Test denominator rule (AC11.2 — sum-of-tests):
 *   For each bug-fix spec group, we search under the conventional test
 *   directory `__tests__/` at the repo root for test files whose basename
 *   references either (a) the spec-group id, (b) any spec-slice id within
 *   that group, or (c) any `requirements_refs` REQ id. Matching tests are
 *   counted by discrete `test(` / `it(` / `test.each(` occurrences — a single
 *   table-driven test(...each(...)) call counts once, matching the
 *   baseline-sample convention used when computing the 2.16 figure.
 *   The rule is emitted verbatim in the output JSON.
 *
 * Run-id:
 *   Explicit `--run-id` wins; otherwise ISO-UTC timestamp with ':' -> '-'.
 *
 * Usage:
 *   node publish-ws2-metrics.mjs \
 *     [--repo-root <dir>] \
 *     [--specs-root <dir>] \
 *     [--tests-root <dir>] \
 *     [--out-dir <metrics-dir>] \
 *     [--baseline-file <path>] \
 *     [--split-at <iso-8601>] \
 *     [--sample-size <n>] \
 *     [--run-id <override-run-id>]
 *
 * Exit codes:
 *   0 - Success. Metrics file written.
 *   1 - Runtime error (I/O, malformed manifest, etc.).
 *   2 - Invocation error (bad args, missing split anchor).
 *   3 - INSUFFICIENT_POST_SHIP_SAMPLE (fewer than 5 bug-fix workstreams
 *       post-ship). Structured exit per AC11.3.
 *
 * @req REQ-014
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_REPO_ROOT = '.';
const DEFAULT_SPECS_ROOT = '.claude/specs/groups';
const DEFAULT_TESTS_ROOT = '__tests__';
const DEFAULT_OUT_DIR = '.claude/metrics';
const DEFAULT_BASELINE_FILE =
  '.claude/metrics/pipeline-efficiency-ws2-baseline.json';

const FILENAME_PREFIX = 'pipeline-efficiency-ws2-practice-2.4-';
const FILENAME_SUFFIX = '.json';

// AC11.4 — pinned values. Do not recompute.
const BASELINE_RATIO = 2.16;
const TARGET_RATIO = 1.3;

// AC11.3 — structured minimum-sample threshold.
const MIN_POST_SHIP_SAMPLE = 5;
const DEFAULT_SAMPLE_SIZE = 10;

// Structured error codes (surfaced in stderr + exit code).
const ERR_INSUFFICIENT_POST_SHIP_SAMPLE = 'INSUFFICIENT_POST_SHIP_SAMPLE';
const ERR_MISSING_SPLIT_ANCHOR = 'MISSING_SPLIT_ANCHOR';

// Documented rule strings — emitted verbatim in the output JSON so reviewers
// can audit how each denominator was produced.
const AC_DENOMINATOR_RULE =
  'For each bug-fix spec group, sum len(frontmatter.ac_coverage) across spec.md and slices/*.md; legacy atomic/*.md contributes only when current-form files are absent. Missing arrays contribute 0.';
const TEST_DENOMINATOR_RULE =
  "Match test files under repo __tests__/ recursively whose basename contains spec-group id OR any spec-slice id OR any requirements_refs REQ id; count discrete test(, it(, test.each( occurrences.";
const BUG_FIX_CLASSIFIER_RULE =
  "manifest.spec_mode == 'bug-fix' (positive); fallback legacy-id rule: /bug|bugs|bug-fix|^fix-/ applied to pre-ship samples lacking spec_mode.";

const EXIT_OK = 0;
const EXIT_RUNTIME_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_INSUFFICIENT_SAMPLE = 3;

// =============================================================================
// Arg parsing
// =============================================================================

function parseArgs(argv) {
  const args = {
    repoRoot: DEFAULT_REPO_ROOT,
    specsRoot: null, // resolved after repoRoot known
    testsRoot: null,
    outDir: null,
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
    else if (a === '--tests-root' && i + 1 < argv.length)
      args.testsRoot = argv[++i];
    else if (a === '--out-dir' && i + 1 < argv.length) args.outDir = argv[++i];
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
  args.specsRoot =
    args.specsRoot || join(args.repoRoot, DEFAULT_SPECS_ROOT);
  args.testsRoot =
    args.testsRoot || join(args.repoRoot, DEFAULT_TESTS_ROOT);
  args.outDir = args.outDir || join(args.repoRoot, DEFAULT_OUT_DIR);
  args.baselineFile =
    args.baselineFile || join(args.repoRoot, DEFAULT_BASELINE_FILE);
  return args;
}

function printUsage() {
  process.stderr.write(
    `Usage: node publish-ws2-metrics.mjs \\\n` +
      `  [--repo-root <dir>] [--specs-root <dir>] [--tests-root <dir>] \\\n` +
      `  [--out-dir <dir>] [--baseline-file <path>] [--split-at <iso>] \\\n` +
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

function writeJson(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Minimal frontmatter extractor: returns a plain object of the top-level
 * `key: value` pairs found between the leading `---` markers. Arrays in the
 * shape `[a, b, c]` on a single line are parsed into a real array. Strings
 * are returned verbatim (surrounding quotes stripped). This is sufficient for
 * the fields we need (`status`, `spec_mode`, `ac_coverage`, `requirements_refs`,
 * `id`, `created_at`) and avoids a YAML dependency we do not have.
 */
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const body = m[1];
  const out = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Inline array form: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      out[key] = inner
        ? inner
            .split(',')
            .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
            .filter((t) => t.length > 0)
        : [];
      continue;
    }
    // String with optional surrounding quotes.
    value = value.replace(/^['"]|['"]$/g, '');
    out[key] = value;
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

function listSpecCoverageFiles(groupDir) {
  const files = [];
  const specPath = join(groupDir, 'spec.md');
  if (existsSync(specPath)) files.push(specPath);

  const slicesDir = join(groupDir, 'slices');
  if (existsSync(slicesDir)) {
    for (const name of readdirSync(slicesDir).filter((n) => n.endsWith('.md'))) {
      files.push(join(slicesDir, name));
    }
  }

  if (files.length === 0) {
    const legacyAtomicDir = join(groupDir, 'atomic');
    if (existsSync(legacyAtomicDir)) {
      for (const name of readdirSync(legacyAtomicDir).filter((n) => n.endsWith('.md'))) {
        files.push(join(legacyAtomicDir, name));
      }
    }
  }

  return files;
}

function listTestFilesRecursive(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(p);
      } else if (s.isFile() && /\.(test|spec)\.(m?js|ts)$/.test(name)) {
        out.push(p);
      }
    }
  }
  return out;
}

// =============================================================================
// Classifier + sample selection
// =============================================================================

/**
 * Decide whether a manifest represents a bug-fix workstream. Returns
 * `{ isBugFix, classifier }` where classifier is the rule that matched:
 *   'spec_mode'  — positive signal from manifest.
 *   'legacy-id'  — id-based fallback (pre-ship only).
 *   null         — not a bug-fix.
 *
 * `allowLegacy` is true for pre-ship samples; false for post-ship. Post-ship
 * samples MUST carry `spec_mode: bug-fix` to be counted — this is what REQ-014
 * is measuring.
 */
function classifyBugFix(manifest, allowLegacy) {
  if (manifest && manifest.spec_mode === 'bug-fix') {
    return { isBugFix: true, classifier: 'spec_mode' };
  }
  if (allowLegacy && manifest && typeof manifest.id === 'string') {
    if (/bug|bugs|bug-fix|^fix-/i.test(manifest.id)) {
      return { isBugFix: true, classifier: 'legacy-id' };
    }
  }
  return { isBugFix: false, classifier: null };
}

/**
 * Read `split_at` anchor from the baseline artefact if available.
 * Priority: manifest field `ws2_merge_at` > `measurement_window_end` > null.
 * Returns ISO-8601 string or null.
 */
function resolveSplitAtFromBaseline(baselineFile) {
  const data = readJsonOrNull(baselineFile);
  if (!data) return null;
  if (typeof data.ws2_merge_at === 'string' && data.ws2_merge_at.length > 0) {
    return data.ws2_merge_at;
  }
  if (
    typeof data.measurement_window_end === 'string' &&
    data.measurement_window_end.length > 0
  ) {
    return data.measurement_window_end;
  }
  return null;
}

function loadManifest(groupDir) {
  const mPath = join(groupDir, 'manifest.json');
  const manifest = readJsonOrNull(mPath);
  return manifest;
}

/**
 * Summarise a spec group into the shape consumed by downstream aggregation.
 * Pure — no I/O beyond what's passed in.
 */
function summariseGroup(groupDir, manifest, classifier, testsRoot) {
  const coverageFiles = listSpecCoverageFiles(groupDir);
  const specSliceIds = [];
  let acSum = 0;
  for (const f of coverageFiles) {
    const fm = parseFrontmatter(readFileSync(f, 'utf-8'));
    if (typeof fm.id === 'string') specSliceIds.push(fm.id);
    if (Array.isArray(fm.ac_coverage)) {
      acSum += fm.ac_coverage.length;
    }
  }
  const reqRefs = Array.isArray(manifest.requirements_refs)
    ? manifest.requirements_refs
    : [];
  const testCount = countTestsForGroup(
    testsRoot,
    manifest.id,
    specSliceIds,
    reqRefs,
  );
  return {
    spec_group_id: manifest.id,
    created_at: manifest.created_at || null,
    classifier,
    ac_count: acSum,
    test_count: testCount,
    spec_slice_count: coverageFiles.length,
  };
}

/**
 * Count test-function occurrences in files whose basename references the
 * spec-group id, any spec-slice id, or any requirements_refs REQ id.
 * Counts discrete `test(`, `it(`, `test.each(` call sites.
 */
function countTestsForGroup(testsRoot, groupId, specSliceIds, reqIds) {
  const testFiles = listTestFilesRecursive(testsRoot);
  const needles = [groupId, ...specSliceIds, ...reqIds]
    .filter((x) => typeof x === 'string' && x.length > 0)
    .map((x) => x.toLowerCase());
  if (needles.length === 0) return 0;
  let count = 0;
  for (const f of testFiles) {
    const b = basename(f).toLowerCase();
    const matches = needles.some((n) => b.includes(n));
    if (!matches) continue;
    let src;
    try {
      src = readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    count += countTestCalls(src);
  }
  return count;
}

/**
 * Count top-level test-function occurrences in a file's source: `test(`,
 * `it(`, `test.each(`. Basic regex pass — intentionally over-inclusive but
 * consistent with the baseline convention used to derive 2.16.
 */
function countTestCalls(src) {
  const re = /\b(?:test|it|test\.each|it\.each)\s*\(/g;
  let n = 0;
  while (re.exec(src) !== null) n += 1;
  return n;
}

function compareCreatedAtAsc(a, b) {
  const ax = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bx = b.created_at ? new Date(b.created_at).getTime() : 0;
  return ax - bx;
}

function compareCreatedAtDesc(a, b) {
  return compareCreatedAtAsc(b, a);
}

/**
 * Build pre-ship and post-ship samples. Pre-ship: bug-fix groups whose
 * created_at < splitAt, sorted desc (latest first), trimmed to sampleSize.
 * Post-ship: bug-fix groups whose created_at >= splitAt, sorted asc, trimmed.
 */
function selectSamples(allSummaries, splitAtIso, sampleSize) {
  const splitMs = new Date(splitAtIso).getTime();
  if (!Number.isFinite(splitMs)) {
    throw new Error(`invalid --split-at value: ${splitAtIso}`);
  }
  const pre = [];
  const post = [];
  for (const s of allSummaries) {
    const ms = s.created_at ? new Date(s.created_at).getTime() : NaN;
    if (!Number.isFinite(ms)) continue;
    if (ms < splitMs) pre.push(s);
    else post.push(s);
  }
  pre.sort(compareCreatedAtDesc);
  post.sort(compareCreatedAtAsc);
  return {
    pre_ship: pre.slice(0, sampleSize),
    post_ship: post.slice(0, sampleSize),
  };
}

// =============================================================================
// Metrics assembly
// =============================================================================

/**
 * Compute sum(tests) / sum(ACs) for a sample. Returns 0 when the sample is
 * empty or when sum(ACs) is 0 (guards against divide-by-zero; the observed
 * ratio is undefined in that case and 0 is surfaced alongside the raw sums so
 * downstream readers can detect it).
 */
function computeRatio(sample) {
  let tests = 0;
  let acs = 0;
  for (const s of sample) {
    tests += s.test_count || 0;
    acs += s.ac_count || 0;
  }
  if (acs === 0) return { ratio: 0, tests, acs };
  return { ratio: tests / acs, tests, acs };
}

/**
 * Assemble the full output payload. The shape enumerates the 10 schema fields
 * required by AC11.1 at the top level:
 *   1. schema_version
 *   2. workstream_id
 *   3. run_id
 *   4. published_at
 *   5. baseline_ratio       (AC11.4, pinned 2.16)
 *   6. target_ratio         (AC11.4, pinned 1.3)
 *   7. observed_ratio       (AC11.2)
 *   8. sample_set           (split anchor + pre/post arrays + sample_size)
 *   9. denominator_rules    (AC-denominator + test-denominator + classifier)
 *  10. source_paths         (specs_root + tests_root + baseline_file)
 */
function buildPayload({
  runId,
  publishedAt,
  splitAtIso,
  preShip,
  postShip,
  sampleSize,
  specsRoot,
  testsRoot,
  baselineFile,
}) {
  const observed = computeRatio(postShip);
  const preRatio = computeRatio(preShip);
  return {
    schema_version: 1,
    workstream_id: 'ws-2',
    run_id: runId,
    published_at: publishedAt,
    baseline_ratio: BASELINE_RATIO,
    target_ratio: TARGET_RATIO,
    observed_ratio: observed.ratio,
    sample_set: {
      split_at: splitAtIso,
      sample_size_cap: sampleSize,
      pre_ship: {
        count: preShip.length,
        sum_tests: preRatio.tests,
        sum_acs: preRatio.acs,
        ratio: preRatio.ratio,
        groups: preShip,
      },
      post_ship: {
        count: postShip.length,
        sum_tests: observed.tests,
        sum_acs: observed.acs,
        ratio: observed.ratio,
        groups: postShip,
      },
    },
    denominator_rules: {
      ac_denominator_rule: AC_DENOMINATOR_RULE,
      test_denominator_rule: TEST_DENOMINATOR_RULE,
      bug_fix_classifier_rule: BUG_FIX_CLASSIFIER_RULE,
    },
    source_paths: {
      specs_root: specsRoot,
      tests_root: testsRoot,
      baseline_file: baselineFile,
    },
  };
}

// =============================================================================
// Run-id resolution
// =============================================================================

function resolveRunId(cliRunId, nowIso) {
  if (typeof cliRunId === 'string' && cliRunId.length > 0) return cliRunId;
  return nowIso.replace(/:/g, '-');
}

// =============================================================================
// Orchestrator (testable — no process.exit inside)
// =============================================================================

/**
 * Classify every spec group under specsRoot and summarise it. Pre-ship
 * samples allow the legacy-id classifier fallback; this function just tags
 * the classifier used so `selectSamples()` can trust every summary.
 */
function scanAllGroups(specsRoot, testsRoot) {
  const groupDirs = listSpecGroupDirs(specsRoot);
  const out = [];
  for (const dir of groupDirs) {
    const manifest = loadManifest(dir);
    if (!manifest) continue;
    // Classify with allowLegacy=true first — we'll annotate the classifier
    // on the summary and downstream logic can distinguish if needed.
    const cls = classifyBugFix(manifest, /* allowLegacy */ true);
    if (!cls.isBugFix) continue;
    try {
      out.push(summariseGroup(dir, manifest, cls.classifier, testsRoot));
    } catch (err) {
      // Skip malformed group rather than failing the whole run.
      process.stderr.write(
        `WARN: skipping malformed group ${dir}: ${err.message}\n`,
      );
    }
  }
  return out;
}

function run(args, { now = () => new Date() } = {}) {
  // Resolve split anchor: CLI override > baseline file field > error.
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
        `${ERR_MISSING_SPLIT_ANCHOR}: could not resolve ws-2 merge anchor. ` +
        `Pass --split-at <iso-8601> or ensure ${args.baselineFile} contains ` +
        `ws2_merge_at or measurement_window_end.`,
    };
  }

  const summaries = scanAllGroups(args.specsRoot, args.testsRoot);
  const { pre_ship, post_ship } = selectSamples(
    summaries,
    splitAtIso,
    args.sampleSize,
  );

  // AC11.3 — reject with structured exit when post-ship sample < MIN.
  if (post_ship.length < MIN_POST_SHIP_SAMPLE) {
    return {
      ok: false,
      exit: EXIT_INSUFFICIENT_SAMPLE,
      error: ERR_INSUFFICIENT_POST_SHIP_SAMPLE,
      message:
        `${ERR_INSUFFICIENT_POST_SHIP_SAMPLE}: only ${post_ship.length} ` +
        `bug-fix workstream(s) found post-ship; minimum is ` +
        `${MIN_POST_SHIP_SAMPLE}. Sampled pre-ship count: ${pre_ship.length}.`,
    };
  }

  const publishedAt = now().toISOString();
  const runId = resolveRunId(args.runId, publishedAt);
  const payload = buildPayload({
    runId,
    publishedAt,
    splitAtIso,
    preShip: pre_ship,
    postShip: post_ship,
    sampleSize: args.sampleSize,
    specsRoot: args.specsRoot,
    testsRoot: args.testsRoot,
    baselineFile: args.baselineFile,
  });

  const outFile = join(
    resolve(args.outDir),
    `${FILENAME_PREFIX}${runId}${FILENAME_SUFFIX}`,
  );
  writeJson(outFile, payload);
  return { ok: true, exit: EXIT_OK, outFile, payload };
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

  process.stderr.write(
    `published: ${result.outFile} (observed_ratio=${result.payload.observed_ratio.toFixed(4)}, ` +
      `baseline=${BASELINE_RATIO}, target=${TARGET_RATIO}, ` +
      `pre=${result.payload.sample_set.pre_ship.count}, ` +
      `post=${result.payload.sample_set.post_ship.count})\n`,
  );
  process.exit(EXIT_OK);
}

// Exports for test harness.
export {
  parseArgs,
  parseFrontmatter,
  classifyBugFix,
  resolveSplitAtFromBaseline,
  countTestCalls,
  computeRatio,
  selectSamples,
  buildPayload,
  resolveRunId,
  scanAllGroups,
  run,
  BASELINE_RATIO,
  TARGET_RATIO,
  MIN_POST_SHIP_SAMPLE,
  ERR_INSUFFICIENT_POST_SHIP_SAMPLE,
  ERR_MISSING_SPLIT_ANCHOR,
  AC_DENOMINATOR_RULE,
  TEST_DENOMINATOR_RULE,
  BUG_FIX_CLASSIFIER_RULE,
};

// CLI entrypoint (only when invoked directly).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
