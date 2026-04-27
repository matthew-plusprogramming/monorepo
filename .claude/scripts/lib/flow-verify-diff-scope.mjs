#!/usr/bin/env node

/**
 * Flow-Verify Diff-Scope Resolution Helper
 *
 * Pure helper that resolves the scope of flow-verify execution by computing
 * the set of files changed between a git base ref and HEAD, then mapping
 * those files to trace module IDs via `.claude/traces/trace.config.json`
 * `fileGlobs`.
 *
 * The helper decouples diff-scope heuristics from agent wiring so it can
 * be unit-tested in isolation and reused by `flow-verify-checks.mjs`
 * (consumer wired later in as-002).
 *
 * Resolution strategy:
 *   1. Attempt `git diff --name-only <base>..HEAD` (default base: `HEAD~10`).
 *   2. On failure (missing ancestor / single-commit history / rebase state),
 *      fall back to `HEAD~1..HEAD` and record `fallback: "head-1"`.
 *   3. On second failure (only 1 commit in history), fall back to full-repo
 *      scope and record `fallback: "full-repo"`.
 *
 * Return shape — `{ scope, changed_files, affected_modules, fallback }`:
 *   - scope: "diff" | "full"
 *     "diff" when a git diff succeeded (even if empty — empty diff is NOT an
 *     error; it signals trivial-pass to the caller).
 *     "full" when the full-repo fallback kicked in.
 *   - changed_files: string[] (relative paths; empty array on trivial-pass
 *     or full-repo fallback).
 *   - affected_modules: string[] (module IDs from trace.config.json that
 *     own at least one changed file; deduplicated, insertion-ordered).
 *   - fallback: "none" | "head-1" | "full-repo" per REQ-006 EARS enum.
 *
 * Non-goals:
 *   - NO agent prompt mutation.
 *   - NO wiring into flow-verify-checks.mjs (that is as-002).
 *   - NO carry-forward-findings evaluation (that is as-002/003).
 *   - NO new-boundary-crossing-symbol detection (that is as-003).
 *
 * Implements: REQ-006 AC1.1, AC1.2, AC1.3, AC1.4
 * Spec: sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-001
 * Contract: contract-flow-verify-diff-scope (spec.md §Interfaces-&-Contracts)
 */

import { execFileSync } from 'node:child_process';
import { loadTraceConfig, fileToModule, resolveProjectRoot } from './trace-utils.mjs';

// =============================================================================
// Constants
// =============================================================================

/**
 * Default base ref for diff computation.
 *
 * `HEAD~10` is the primary attempt. The 10-commit window is a compromise
 * between diff-scope coverage (large enough to span typical feature branches)
 * and diff-size bound (small enough to keep `git diff` output tractable).
 *
 * Consumers may override with an explicit branch-base ref (e.g., `main`).
 *
 * @type {string}
 */
const DEFAULT_DIFF_BASE = 'HEAD~10';

/**
 * Secondary fallback base ref when `DEFAULT_DIFF_BASE` fails.
 *
 * Represents the minimum-viable single-commit diff. If this also fails
 * (i.e., worktree has only 1 commit in history), the helper escalates
 * to full-repo scope.
 *
 * @type {string}
 */
const FALLBACK_SINGLE_COMMIT_BASE = 'HEAD~1';

/**
 * Fallback enum values per REQ-006 EARS wording.
 *
 * Exported alongside `resolveDiffScope` so consumers can switch/compare
 * against literal string values without re-declaring them.
 *
 * @type {Readonly<{ NONE: "none", HEAD_1: "head-1", FULL_REPO: "full-repo" }>}
 */
export const DIFF_SCOPE_FALLBACK = Object.freeze({
  NONE: 'none',
  HEAD_1: 'head-1',
  FULL_REPO: 'full-repo',
});

/**
 * Scope enum values.
 *
 * @type {Readonly<{ DIFF: "diff", FULL: "full" }>}
 */
export const DIFF_SCOPE = Object.freeze({
  DIFF: 'diff',
  FULL: 'full',
});

// =============================================================================
// Internal — git diff runner (injectable for tests)
// =============================================================================

/**
 * Run `git diff --name-only <base>..HEAD` and return the list of changed
 * files (one per output line, trimmed, empties dropped).
 *
 * Uses `execFileSync` (never `exec` with a shell) so the base ref is passed
 * literally even if it contains shell-meaningful characters. Suppresses
 * ANSI color via `-c color.ui=never` for deterministic output.
 *
 * Throws on any non-zero exit (missing ancestor, not-a-repo, etc.) — the
 * caller interprets the failure and walks the ancestry-fallback ladder.
 *
 * Exposed via dependency injection (`deps.runGitDiff`) so unit tests can
 * simulate success/failure without touching a real git repo.
 *
 * @param {string} base - Git base ref (e.g., `HEAD~10`, `main`).
 * @param {string} cwd - Repo working directory.
 * @returns {string[]} List of changed file paths relative to repo root.
 * @throws {Error} If git invocation exits non-zero.
 */
function defaultRunGitDiff(base, cwd) {
  const stdout = execFileSync(
    'git',
    ['-c', 'color.ui=never', 'diff', '--name-only', `${base}..HEAD`],
    {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

// =============================================================================
// Internal — module mapping
// =============================================================================

/**
 * Map a list of changed file paths to their owning trace module IDs.
 *
 * First-match-wins per file (delegates to `fileToModule` from trace-utils).
 * Deduplicates module IDs while preserving first-seen order so test output
 * is deterministic across platforms.
 *
 * Files that do not match any module (untraced paths such as docs, specs,
 * config outside trace coverage) are silently dropped from the module list
 * but remain present in `changed_files` so callers retain full visibility.
 *
 * @param {string[]} changedFiles - File paths relative to project root.
 * @param {{ modules: Array<{ id: string, fileGlobs: string[] }> }} config - Trace config.
 * @returns {string[]} Deduplicated, insertion-ordered module IDs.
 */
function mapFilesToModules(changedFiles, config) {
  const seen = new Set();
  const moduleIds = [];
  for (const filePath of changedFiles) {
    const mod = fileToModule(filePath, config);
    if (mod && !seen.has(mod.id)) {
      seen.add(mod.id);
      moduleIds.push(mod.id);
    }
  }
  return moduleIds;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * @typedef {object} ResolveDiffScopeOptions
 * @property {string} [base] - Git base ref for diff computation. Defaults to `HEAD~10`.
 * @property {"prd-review"|"spec-review"|"impl-verify"|"post-impl"} [stage] - Flow-verify
 *   stage label. Stored for caller visibility; does NOT affect resolution
 *   behavior in this helper (as-003 adds stage-sensitive rejection at the
 *   consumer boundary).
 * @property {string} [cwd] - Working directory for git invocation. Defaults
 *   to the canonicalized project root via `resolveProjectRoot()`.
 * @property {{ modules: Array<{ id: string, fileGlobs: string[] }> }} [config] - Pre-loaded
 *   trace config. When absent, the helper loads from `.claude/traces/trace.config.json`.
 * @property {(base: string, cwd: string) => string[]} [runGitDiff] - Test seam
 *   for injecting git behavior. Must throw on non-zero git exit.
 */

/**
 * @typedef {object} ResolveDiffScopeResult
 * @property {"diff"|"full"} scope - "diff" when git diff produced a list
 *   (including empty); "full" when full-repo fallback kicked in.
 * @property {string[]} changed_files - Files changed between base and HEAD.
 *   Empty on trivial-pass or full-repo fallback.
 * @property {string[]} affected_modules - Trace module IDs owning at least
 *   one changed file (deduplicated).
 * @property {"none"|"head-1"|"full-repo"} fallback - Which fallback step
 *   produced the result. "none" = primary base worked OR diff was empty
 *   at primary base (trivial-pass). "head-1" = primary failed, HEAD~1
 *   worked. "full-repo" = both git attempts failed.
 */

/**
 * Resolve the flow-verify diff scope.
 *
 * This is the single public entry-point for as-001. Consumers (as-002 will
 * wire it into `flow-verify-checks.mjs`) pass a stage label and an optional
 * base ref; the helper returns a structured result describing which files
 * and modules are in scope, plus which fallback (if any) produced the answer.
 *
 * Contract guarantees (REQ-006 EARS):
 *   - WHEN `git diff <base>..HEAD` fails → fall back to `HEAD~1` then full-repo.
 *   - AND fallback enum `{"none" | "head-1" | "full-repo"}` recorded on every return.
 *   - IF diff is empty → `scope: "diff"`, `changed_files: []`, `affected_modules: []`,
 *     `fallback: "none"` (trivial-pass signal to caller).
 *   - Maps changed files to module IDs via `trace.config.json` `fileGlobs`.
 *
 * @param {ResolveDiffScopeOptions} [options]
 * @returns {ResolveDiffScopeResult}
 */
export function resolveDiffScope(options = {}) {
  const {
    base = DEFAULT_DIFF_BASE,
    // `stage` is accepted but currently unused inside resolveDiffScope —
    // it's part of the public contract so consumers can pass through a
    // single options object. Stage-sensitive policy lives at the consumer
    // boundary (as-003).
    stage: _stage,
    cwd = resolveProjectRoot(),
    config: providedConfig,
    runGitDiff = defaultRunGitDiff,
  } = options;

  const config = providedConfig ?? loadTraceConfig(cwd);

  // Primary attempt: <base>..HEAD (default HEAD~10..HEAD).
  let changedFiles;
  let fallback = DIFF_SCOPE_FALLBACK.NONE;

  try {
    changedFiles = runGitDiff(base, cwd);
  } catch (_primaryErr) {
    // Secondary attempt: HEAD~1..HEAD.
    try {
      changedFiles = runGitDiff(FALLBACK_SINGLE_COMMIT_BASE, cwd);
      fallback = DIFF_SCOPE_FALLBACK.HEAD_1;
    } catch (_secondaryErr) {
      // Full-repo fallback — no diff computable (single-commit history).
      return {
        scope: DIFF_SCOPE.FULL,
        changed_files: [],
        affected_modules: [],
        fallback: DIFF_SCOPE_FALLBACK.FULL_REPO,
      };
    }
  }

  // Empty diff — trivial-pass signal. Not an error.
  // Preserve `scope: "diff"` so the caller can distinguish trivial-pass
  // (nothing to verify) from full-repo fallback (everything to verify).
  if (changedFiles.length === 0) {
    return {
      scope: DIFF_SCOPE.DIFF,
      changed_files: [],
      affected_modules: [],
      fallback,
    };
  }

  return {
    scope: DIFF_SCOPE.DIFF,
    changed_files: changedFiles,
    affected_modules: mapFilesToModules(changedFiles, config),
    fallback,
  };
}
