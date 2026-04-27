#!/usr/bin/env node

/**
 * Single PostToolUse wrapper that sequences manifest validation in deterministic order.
 *
 * Spec: sg-enforcement-layer-gaps Task 12 / Task 3.2a (chk-hook-f3b50821).
 * Implements AC-3.3 ordering and short-circuit, AC-3.2 archive exclusion, AC-3.2a
 * compensating control acceptance, plus REQ-SH-003 PASS/FAIL single-line output
 * so operators can grep `manifest-shape-lint:` in tool-call logs.
 *
 * Sequence (deterministic, intra-script):
 *   1. Receives `{{file}}` path from hook-wrapper.mjs.
 *   2. Archive-path filter: if path includes `.claude/specs/archive/` skip both
 *      checks and exit 0 (AC-3.2).
 *   3. Invoke `validate-manifest.mjs <file>` synchronously; capture exit code + stderr.
 *   4. If exit code >= 2 (structural: missing file / malformed JSON): short-circuit,
 *      emit warning to stderr, emit `manifest-shape-lint: STRUCTURAL_ERROR`, exit 0.
 *   5. If exit code == 0 (valid) or == 1 (schema/shape invalid but parseable):
 *      optionally invoke `shape-lint-hook.mjs <file>` if present (Task 11 — may not
 *      yet be shipped). Aggregate stderr. Emit one of
 *        manifest-shape-lint: PASS
 *        manifest-shape-lint: FAIL
 *      then ALWAYS exit 0 (hook never blocks, per NFR-2).
 *
 * The validator CLI remains authoritative blocking via CI/pre-commit (AC-2.5);
 * this wrapper is strictly advisory at edit-time.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKillSwitchPinned } from './lib/kill-switch.mjs';
import { getCanonicalProjectDir } from './lib/hook-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Named constants (no magic values)
// ---------------------------------------------------------------------------

const EXIT_HOOK_OK = 0;

/** Validator exit-code bands. */
const VALIDATOR_EXIT_VALID = 0;
const VALIDATOR_EXIT_INVALID = 1;
/** Any code >= VALIDATOR_EXIT_STRUCTURAL_MIN is treated as a structural failure
 * (e.g., missing file, unparseable JSON). Short-circuit rule per AC-3.3. */
const VALIDATOR_EXIT_STRUCTURAL_MIN = 2;

/** Archive path segment — excluded per AC-3.2. */
const ARCHIVE_PATH_SEGMENT = '.claude/specs/archive/';

/** Default output prefix operators can grep for. */
const OUTPUT_PREFIX = 'manifest-shape-lint:';

/** Kill-switch sentinel relative path (AC-3.4). */
const KILL_SWITCH_SENTINEL_RELATIVE = '.claude/coordination/shape-lint-disabled';

/** Per-child-process timeout (ms). Hook NEVER blocks, but we bound runtime to
 * keep PostToolUse snappy (NFR-1 budget lives in shape-lint-hook, this wrapper
 * is only a sequencer). */
const CHILD_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findProjectRoot() {
  // as-012 (REQ-003.6): delegate to canonicalizer; fall back to ancestor walk.
  try {
    return getCanonicalProjectDir();
  } catch {
    /* fall through */
  }
  let dir = __dirname;
  while (dir !== '/') {
    if (existsSync(join(dir, '.claude'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();
const VALIDATE_MANIFEST_PATH = join(
  PROJECT_ROOT,
  '.claude',
  'scripts',
  'validate-manifest.mjs'
);
const SHAPE_LINT_HOOK_PATH = join(
  PROJECT_ROOT,
  '.claude',
  'scripts',
  'shape-lint-hook.mjs'
);
const KILL_SWITCH_SENTINEL_PATH = join(PROJECT_ROOT, KILL_SWITCH_SENTINEL_RELATIVE);

/**
 * Run a child process synchronously, returning {code, stderr, stdout}.
 * Captures but does not fail on missing script (caller decides).
 */
function runChild(scriptPath, args) {
  const r = spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf-8',
    timeout: CHILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: typeof r.status === 'number' ? r.status : 2,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

/**
 * Determine whether a path falls inside the archive exclusion zone (AC-3.2).
 */
function isArchivePath(filePath) {
  return filePath.includes(ARCHIVE_PATH_SEGMENT);
}

/**
 * Main entry. Exit is ALWAYS 0 (never blocks) per NFR-2 / AC-3.3.
 */
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    // No file provided — nothing to lint. Exit 0 (fail-open per REQ-SH-002).
    process.stdout.write(`${OUTPUT_PREFIX} SKIP no-file-arg\n`);
    process.exit(EXIT_HOOK_OK);
  }

  const filePath = resolve(args[0]);

  // AC-3.2: archive exclusion.
  if (isArchivePath(filePath)) {
    process.stdout.write(`${OUTPUT_PREFIX} SKIP archive-path\n`);
    process.exit(EXIT_HOOK_OK);
  }

  // AC-3.4 / AC-3.5 / AC-3.6: kill-switch OR-gate with inode pinning.
  // Re-read the sentinel + env var state on EVERY invocation (no caching
  // across invocations; pin lives only within this process, expires at exit).
  const killSwitch = readKillSwitchPinned(KILL_SWITCH_SENTINEL_PATH);
  if (killSwitch.active) {
    process.stdout.write(`${OUTPUT_PREFIX} SKIP kill-switch reason=${killSwitch.reason}\n`);
    process.exit(EXIT_HOOK_OK);
  }

  // Step 3: validate-manifest.
  if (!existsSync(VALIDATE_MANIFEST_PATH)) {
    // Missing validator is a structural error; fail-open per REQ-SH-002 but surface to stderr.
    process.stderr.write(
      `[manifest-post-edit-hook] validate-manifest.mjs not found at ${VALIDATE_MANIFEST_PATH} — skipping\n`
    );
    process.stdout.write(`${OUTPUT_PREFIX} SKIP validator-missing\n`);
    process.exit(EXIT_HOOK_OK);
  }

  const vm = runChild(VALIDATE_MANIFEST_PATH, [filePath]);

  // AC-3.3: short-circuit on structural error.
  if (vm.code >= VALIDATOR_EXIT_STRUCTURAL_MIN) {
    process.stderr.write(
      `[manifest-post-edit-hook] structural validator error (exit ${vm.code}):\n`
    );
    if (vm.stderr) process.stderr.write(vm.stderr);
    if (vm.error) process.stderr.write(`[manifest-post-edit-hook] child error: ${vm.error}\n`);
    process.stdout.write(`${OUTPUT_PREFIX} STRUCTURAL_ERROR\n`);
    process.exit(EXIT_HOOK_OK);
  }

  // Step 5: optional shape-lint-hook (Task 11 — may not yet be shipped).
  let shapeLintCode = VALIDATOR_EXIT_VALID;
  let shapeLintStderr = '';
  if (existsSync(SHAPE_LINT_HOOK_PATH)) {
    const sl = runChild(SHAPE_LINT_HOOK_PATH, [filePath]);
    shapeLintCode = sl.code;
    shapeLintStderr = sl.stderr;
  }

  // Surface any stderr produced by the children so the user sees actionable output.
  if (vm.stderr) {
    process.stderr.write(vm.stderr);
  }
  if (shapeLintStderr) {
    process.stderr.write(shapeLintStderr);
  }

  // Aggregate status: PASS iff both children exited with VALIDATOR_EXIT_VALID.
  const combinedClean =
    vm.code === VALIDATOR_EXIT_VALID && shapeLintCode === VALIDATOR_EXIT_VALID;
  if (combinedClean) {
    process.stdout.write(`${OUTPUT_PREFIX} PASS\n`);
  } else {
    // AC-2.2 / AC-3.3: advisory warning; hook does NOT block.
    process.stdout.write(
      `${OUTPUT_PREFIX} FAIL validate_exit=${vm.code} shape_lint_exit=${shapeLintCode}\n`
    );
  }

  process.exit(EXIT_HOOK_OK);
}

// Only run main when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
