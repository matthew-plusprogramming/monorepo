#!/usr/bin/env node

/**
 * Grep-lock CI check — threshold literals + pruned-stage dangling refs
 *
 * Implements: NFR-16 (threshold-consumer invariants), NFR-GREP-LOCK-COMPAT,
 *             REQ-003 (pre-test deletion), REQ-004 (pre-review deletion)
 *
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning, as-011, Task C9
 * Contract: contract-threshold-reader-superset-8 §grep_lock + §enforcement
 *
 * ---------------------------------------------------------------------------
 * Check 1 — Threshold literals
 *   Scans `.claude/scripts/**.mjs` for:
 *     - `REQUIRED_CLEAN_PASSES` identifier references
 *     - inline `=== 2` / `>= 2` comparisons
 *   Allowed sites (threshold-internal modules — the canonical writer + helper):
 *     - `.claude/scripts/lib/workflow-dag.mjs`          (exports REQUIRED_CLEAN_PASSES)
 *     - `.claude/scripts/lib/per-gate-threshold-table.mjs` (initial table content)
 *     - `.claude/scripts/lib/snapshot-threshold-reader.mjs` (per-gate reader helper)
 *     - `.claude/scripts/lib/stop-hook-checks.mjs`      (imports REQUIRED_CLEAN_PASSES from workflow-dag)
 *   Per-line allowances (within consumer code):
 *     - Lines where the identifier appears as part of the named constant
 *       `DEFAULT_REQUIRED_CLEAN_PASSES` (backward-compat fallback retained
 *       by as-007..as-010 consumer migration). The literal numeric comparison
 *       `=== 2` / `>= 2` is still forbidden outside threshold-internal modules.
 *     - Comment/JSDoc lines (leading `//`, `*`, `/*`) referencing the symbol
 *       for documentation are allowed.
 *
 * Check 2 — Pruned-stage dangling refs (pre-test / pre-review)
 *   Scans `.claude/scripts/**.mjs` for the substrings `pre-test` and
 *   `pre-review` outside the allow-list. See `STAGE_REFERENCE_ALLOWLIST`
 *   below; derived from as-023 Decision Log §97 (enum-retention sites) and
 *   spec §Task-G2 (8-script superset). Change-log comments are permitted.
 *
 * Scope excludes:
 *   - `__tests__/`, `__fixtures__/`, `archive/` subtrees
 *   - node_modules (never present here, but excluded defensively)
 *
 * Exit codes:
 *   0  - All checks pass
 *   1  - At least one forbidden match found (prints file:line per violation)
 *   2  - Configuration/IO error (unreadable path, missing scripts root)
 *
 * CI registration:
 *   - Invoked via `npm run lint:grep-lock-thresholds` (package.json script entry)
 *   - Should run on every PR touching `.claude/scripts/` or `workflow-dag.mjs`
 *
 * ---------------------------------------------------------------------------
 * SELF-RESOLVED(spec): whitelist derived verbatim from
 *   - spec.md §Contract:threshold-reader-superset (L517-535)
 *   - as-023 Decision Log (L97) for enum-retention sites
 *   - as-011 §References + §Description (whitelist = threshold-table-internal)
 * TODO(assumption, low): CI-pipeline registration added as a package.json
 *   script; no `.github/workflows/*.yml` exists at implementation time.
 *   If/when a workflow file is added, wire this script into it.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// =============================================================================
// Constants
// =============================================================================

/**
 * Repository-root-relative path to the scripts tree we scan.
 * All paths reported in violations are relative to the repo root for stable
 * CI output across machines.
 */
const SCRIPTS_RELATIVE_ROOT = '.claude/scripts';

/**
 * Threshold-internal allow-list (Check 1).
 *
 * These modules are the canonical source of the threshold value. They may
 * freely reference `REQUIRED_CLEAN_PASSES`, `=== 2`, or `>= 2`. Any consumer
 * outside this set MUST read the threshold via SessionThresholdSnapshot
 * (NFR-16) and fall back to `DEFAULT_REQUIRED_CLEAN_PASSES` — never hardcode.
 *
 * Paths are expressed relative to the repo root.
 */
const THRESHOLD_INTERNAL_ALLOWLIST = new Set([
  '.claude/scripts/workflow-dag.mjs',
  '.claude/scripts/lib/workflow-dag.mjs',
  '.claude/scripts/lib/per-gate-threshold-table.mjs',
  '.claude/scripts/lib/snapshot-threshold-reader.mjs',
  '.claude/scripts/lib/stop-hook-checks.mjs',
  // This CI script itself legitimately contains the forbidden patterns
  // inside regex literals, labels, and docstrings. Exempt by definition.
  '.claude/scripts/ci/grep-lock-thresholds.mjs',
]);

/**
 * Pruned-stage reference allow-list (Check 2).
 *
 * `pre-test` and `pre-review` substrings may legitimately appear in:
 *   - the threshold-reader consumer superset (they read stage names structurally but
 *     must not hardcode — enum retention per as-023 ASM)
 *   - `workflow-dag.mjs` (VALID_SUBSTAGES enum retains both values for
 *     in-flight session migration; as-030 owns future removal)
 *   - `lib/hook-utils.mjs` / `lib/unify-preflight.mjs` (enum-retention
 *     sites per as-023 Decision Log §97)
 *   - `session-checkpoint.mjs` (line 237 enum, per as-023)
 *
 * Any other reference is a dangling-ref violation.
 */
const STAGE_REFERENCE_ALLOWLIST = new Set([
  // Canonical DAG module — retains enum values (as-023 ASM)
  '.claude/scripts/workflow-dag.mjs',
  '.claude/scripts/lib/workflow-dag.mjs',
  // 7-consumer threshold-reader superset after legacy reminder deletion
  '.claude/scripts/session-checkpoint.mjs',
  '.claude/scripts/auto-decision.mjs',
  '.claude/scripts/workflow-gate-enforcement.mjs',
  '.claude/scripts/workflow-stop-enforcement.mjs',
  '.claude/scripts/validate-convergence-fields.mjs',
  '.claude/scripts/validate-manifest.mjs',
  '.claude/scripts/migrate-manifest.mjs',
  // Enum-retention sites per as-023 Decision Log §97
  '.claude/scripts/lib/hook-utils.mjs',
  '.claude/scripts/lib/unify-preflight.mjs',
  // Stop-hook uses REQUIRED_CHALLENGER_STAGES from workflow-dag
  '.claude/scripts/lib/stop-hook-checks.mjs',
  // This CI script itself references the forbidden substrings in docs + regex.
  '.claude/scripts/ci/grep-lock-thresholds.mjs',
]);

/**
 * Directories excluded from all scans.
 * Tests + fixtures legitimately contain violation examples for red-path
 * assertions. Archive holds historical versions.
 */
const EXCLUDED_DIRECTORIES = new Set(['__tests__', '__fixtures__', 'archive']);

/**
 * Non-threshold comparison contexts for `=== 2` / `>= 2`.
 *
 * The spec's literal grep string (`=== 2|>= 2`) targets convergence-threshold
 * call sites. Ordinary JS uses `=== 2` / `>= 2` in many non-threshold
 * contexts (string length, array arity, exit codes). To avoid false
 * positives the scanner exempts matches whose line contains any of these
 * tokens to the LEFT of the comparison. These are all observed in the
 * current tree and are not convergence-related:
 *
 *   - `.length`          — string / array length arity checks
 *   - `.size`            — Set / Map size
 *   - `.exitCode`        — child-process exit-code checks
 *   - `.nodeType`        — DOM / AST nodes (rare here)
 *   - `>= 2 chars`       — validation-message string literal (validate-orphans)
 *   - `>= 2 distinct`    — label-count classifier (convergence-pass-recorder)
 *
 * Add future non-threshold hits here with rationale. Pair every addition
 * with a test fixture in `__tests__/ci/grep-lock-thresholds.test.mjs`.
 */
const NON_THRESHOLD_CONTEXT_TOKENS = [
  '.length',
  '.size',
  '.exitCode',
  'childExit',
  'ERR_TIMEOUT',
  '.nodeType',
  '>= 2 chars',
  '>= 2 distinct',
];

/**
 * Forbidden patterns for Check 1. Each entry:
 *   - `label` — human-readable name printed in violation output
 *   - `regex` — line-level match (anchored once per line)
 *   - `allowIfCommentOnly` — skip if the entire match is inside `//` or `*`
 *     leading comment tokens
 *   - `allowIfContainedIn` — skip if the line contains any of these strings
 *     (e.g. `DEFAULT_REQUIRED_CLEAN_PASSES` wraps `REQUIRED_CLEAN_PASSES`)
 *   - `allowIfNonThresholdContext` — apply the NON_THRESHOLD_CONTEXT_TOKENS
 *     filter (only for literal-numeric comparisons)
 */
const THRESHOLD_PATTERNS = [
  {
    label: 'REQUIRED_CLEAN_PASSES identifier',
    regex: /\bREQUIRED_CLEAN_PASSES\b/,
    allowIfCommentOnly: true,
    allowIfContainedIn: ['DEFAULT_REQUIRED_CLEAN_PASSES'],
    allowIfNonThresholdContext: false,
  },
  {
    label: '=== 2 inline threshold comparison',
    // Match `=== 2` where 2 is not followed by a digit (avoid `=== 24`).
    regex: /===\s*2\b(?!\.?\d)/,
    allowIfCommentOnly: true,
    allowIfContainedIn: [],
    allowIfNonThresholdContext: true,
  },
  {
    label: '>= 2 inline threshold comparison',
    // Match `>= 2` where 2 is not followed by a digit (avoid `>= 20`).
    regex: />=\s*2\b(?!\.?\d)/,
    allowIfCommentOnly: true,
    allowIfContainedIn: [],
    allowIfNonThresholdContext: true,
  },
];

/**
 * Forbidden patterns for Check 2.
 *
 * `allowIfCommentOnly: true` permits change-log style comments that mention
 * the pruned stages for historical / migration context (per as-011 spec
 * "allow change-log comments" and as-023 ASM for vitest.config.mjs:21).
 */
const STAGE_PATTERNS = [
  {
    label: 'pre-test dangling reference',
    regex: /\bpre-test\b/,
    allowIfCommentOnly: true,
  },
  {
    label: 'pre-review dangling reference',
    regex: /\bpre-review\b/,
    allowIfCommentOnly: true,
  },
];

// =============================================================================
// Utilities
// =============================================================================

/**
 * Resolve the repo root by walking upward from this file until a `.claude`
 * directory is found. The script lives at `.claude/scripts/ci/` so the root
 * is the second-grandparent.
 */
function resolveRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  // <root>/.claude/scripts/ci/ -> <root>
  return resolve(here, '..', '..', '..');
}

/**
 * Walk a directory recursively, returning absolute paths of every `.mjs`
 * file that is not inside an excluded subtree.
 */
function listMjsFiles(rootAbs) {
  const results = [];
  const stack = [rootAbs];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      throw new Error(`Failed to read directory ${current}: ${err.message}`);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        stack.push(join(current, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.mjs')) {
        results.push(join(current, entry.name));
      }
    }
  }
  return results.sort();
}

/**
 * Return true when the character offset of the match falls inside a comment.
 * Heuristic: match if the line's first non-whitespace characters are `//`,
 * `*`, or `/*`. This is intentionally conservative — inline trailing
 * comments (`code; // note`) may still match, so callers pair this with
 * `allowIfContainedIn` for targeted allowances.
 */
function isLineACommentLine(line) {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

/**
 * Normalize an absolute path to a repo-root-relative POSIX path for stable
 * output and allow-list matching.
 */
function toRepoRelative(absPath, repoRootAbs) {
  const rel = relative(repoRootAbs, absPath);
  return rel.split(sep).join('/');
}

function toScriptsRelative(absPath, scriptsRootAbs) {
  const rel = relative(scriptsRootAbs, absPath);
  return rel.split(sep).join('/');
}

function isAllowlistedPath(rel, scriptsRel, allowlist) {
  const fixtureInternalScripts = new Set([
    'workflow-dag.mjs',
    'lib/workflow-dag.mjs',
    'lib/per-gate-threshold-table.mjs',
    'lib/snapshot-threshold-reader.mjs',
    'lib/stop-hook-checks.mjs',
    'ci/grep-lock-thresholds.mjs',
  ]);
  return (
    allowlist.has(rel) ||
    (fixtureInternalScripts.has(scriptsRel) &&
      allowlist.has(`${SCRIPTS_RELATIVE_ROOT}/${scriptsRel}`))
  );
}

// =============================================================================
// Checks
// =============================================================================

/**
 * Check 1: scan `files` for threshold-literal violations.
 * `files` is an array of absolute paths. Returns an array of violation
 * objects: `{ path, line, column, label, excerpt }`.
 */
function checkThresholdLiterals(files, repoRootAbs, scriptsRootAbs) {
  const violations = [];
  for (const abs of files) {
    const rel = toRepoRelative(abs, repoRootAbs);
    const scriptsRel = toScriptsRelative(abs, scriptsRootAbs);
    if (isAllowlistedPath(rel, scriptsRel, THRESHOLD_INTERNAL_ALLOWLIST)) continue;

    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch (err) {
      throw new Error(`Failed to read ${rel}: ${err.message}`);
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of THRESHOLD_PATTERNS) {
        const match = line.match(pattern.regex);
        if (!match) continue;

        // Comment-only lines document intent; allow.
        if (pattern.allowIfCommentOnly && isLineACommentLine(line)) continue;

        // DEFAULT_REQUIRED_CLEAN_PASSES allowance (Phase-C backward-compat).
        const containedHit = pattern.allowIfContainedIn.some((token) =>
          line.includes(token)
        );
        if (containedHit) continue;

        // Non-threshold numeric comparison context (string length, exit code, etc.)
        if (pattern.allowIfNonThresholdContext) {
          const nonThresholdHit = NON_THRESHOLD_CONTEXT_TOKENS.some((token) =>
            line.includes(token)
          );
          if (nonThresholdHit) continue;
        }

        violations.push({
          path: rel,
          line: i + 1,
          column: (match.index ?? 0) + 1,
          label: pattern.label,
          excerpt: line.trim(),
        });
      }
    }
  }
  return violations;
}

/**
 * Check 2: scan `files` for pre-test / pre-review references outside the
 * allow-list. Returns violation objects in the same shape as Check 1.
 */
function checkPrunedStageReferences(files, repoRootAbs, scriptsRootAbs) {
  const violations = [];
  for (const abs of files) {
    const rel = toRepoRelative(abs, repoRootAbs);
    const scriptsRel = toScriptsRelative(abs, scriptsRootAbs);
    if (isAllowlistedPath(rel, scriptsRel, STAGE_REFERENCE_ALLOWLIST)) continue;

    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch (err) {
      throw new Error(`Failed to read ${rel}: ${err.message}`);
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of STAGE_PATTERNS) {
        const match = line.match(pattern.regex);
        if (!match) continue;

        // Change-log / documentation comment lines are permitted.
        if (pattern.allowIfCommentOnly && isLineACommentLine(line)) continue;

        violations.push({
          path: rel,
          line: i + 1,
          column: (match.index ?? 0) + 1,
          label: pattern.label,
          excerpt: line.trim(),
        });
      }
    }
  }
  return violations;
}

// =============================================================================
// Reporting
// =============================================================================

function formatViolations(heading, violations) {
  const out = [];
  out.push(`\n${heading} (${violations.length} violation(s)):`);
  for (const v of violations) {
    out.push(`  ${v.path}:${v.line}:${v.column}  [${v.label}]`);
    out.push(`    ${v.excerpt}`);
  }
  return out.join('\n');
}

// =============================================================================
// Public API (named export for test injection)
// =============================================================================

/**
 * Run both checks against a caller-provided repo root. Exposed for the
 * fixture-based unit tests (AC11 test strategy). Returns a structured
 * result instead of exiting.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] - Absolute repo root; defaults to the
 *   repository the script lives in.
 * @param {string} [opts.scriptsRoot] - Override the scripts directory to
 *   scan (useful for fixture tests). Defaults to `<repoRoot>/.claude/scripts`.
 * @returns {{ ok: boolean, thresholdViolations: Array, stageViolations: Array }}
 */
export function runGrepLock(opts = {}) {
  const repoRoot = opts.repoRoot ?? resolveRepoRoot();
  const scriptsRoot =
    opts.scriptsRoot ?? join(repoRoot, SCRIPTS_RELATIVE_ROOT);

  if (!existsSync(scriptsRoot)) {
    throw new Error(`Scripts root not found: ${scriptsRoot}`);
  }
  const st = statSync(scriptsRoot);
  if (!st.isDirectory()) {
    throw new Error(`Scripts root is not a directory: ${scriptsRoot}`);
  }

  const files = listMjsFiles(scriptsRoot);
  const thresholdViolations = checkThresholdLiterals(files, repoRoot, scriptsRoot);
  const stageViolations = checkPrunedStageReferences(files, repoRoot, scriptsRoot);
  return {
    ok: thresholdViolations.length === 0 && stageViolations.length === 0,
    thresholdViolations,
    stageViolations,
  };
}

// =============================================================================
// CLI entrypoint
// =============================================================================

function isDirectInvocation() {
  return (
    process.argv[1] &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  );
}

/**
 * Parse CLI arguments. Supports:
 *   --scripts-dir <path>   Override the scripts root (useful for fixtures,
 *                          CI sandboxes, and unit tests). Defaults to
 *                          `<repoRoot>/.claude/scripts`.
 *   --repo-root <path>     Override the repo root (paths in output will
 *                          become relative to this value).
 *   --help / -h            Print usage and exit 0.
 *
 * Unknown flags exit 2 with a stderr error to keep CI noise low.
 */
function parseCliArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--scripts-dir') {
      opts.scriptsRoot = resolve(argv[++i] ?? '');
    } else if (arg.startsWith('--scripts-dir=')) {
      opts.scriptsRoot = resolve(arg.slice('--scripts-dir='.length));
    } else if (arg === '--repo-root') {
      opts.repoRoot = resolve(argv[++i] ?? '');
    } else if (arg.startsWith('--repo-root=')) {
      opts.repoRoot = resolve(arg.slice('--repo-root='.length));
    } else {
      const err = new Error(`unknown argument: ${arg}`);
      err.code = 'UNKNOWN_ARG';
      throw err;
    }
  }
  return opts;
}

const USAGE = [
  'Usage: grep-lock-thresholds.mjs [--scripts-dir <path>] [--repo-root <path>]',
  '',
  'Options:',
  '  --scripts-dir <path>   Scripts tree to scan (default: <repoRoot>/.claude/scripts)',
  '  --repo-root <path>     Repo root for relative-path reporting',
  '  --help, -h             Show this help message',
  '',
  'Exit codes: 0 pass, 1 violation(s) found, 2 config/IO error.',
].join('\n');

function main() {
  let cli;
  try {
    cli = parseCliArgs(process.argv);
  } catch (err) {
    process.stderr.write(`grep-lock-thresholds: ${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (cli.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  let result;
  try {
    result = runGrepLock({
      repoRoot: cli.repoRoot,
      scriptsRoot: cli.scriptsRoot,
    });
  } catch (err) {
    process.stderr.write(`grep-lock-thresholds: configuration error: ${err.message}\n`);
    process.exit(2);
  }

  if (result.ok) {
    process.stdout.write(
      'grep-lock-thresholds: PASS (no threshold literals or pruned-stage dangling refs outside allow-list)\n'
    );
    process.exit(0);
  }

  if (result.thresholdViolations.length > 0) {
    process.stderr.write(
      formatViolations('FAIL — threshold literals', result.thresholdViolations) + '\n'
    );
  }
  if (result.stageViolations.length > 0) {
    process.stderr.write(
      formatViolations('FAIL — pruned-stage dangling refs', result.stageViolations) + '\n'
    );
  }
  process.stderr.write(
    `\ngrep-lock-thresholds: FAIL (${result.thresholdViolations.length + result.stageViolations.length} total violation(s))\n`
  );
  process.exit(1);
}

if (isDirectInvocation()) {
  main();
}
