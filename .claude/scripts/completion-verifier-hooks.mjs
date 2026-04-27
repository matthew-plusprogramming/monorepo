#!/usr/bin/env node

/**
 * completion-verifier-hooks.mjs
 *
 * Thin CLI wrappers that bridge completion-verifier's project-specific gates
 * (`.claude/completion-gates.md`) to the two pipeline-efficiency preflight
 * primitives:
 *
 *   1. `verify-hash-chain`         → spawn verify-audit-chain.mjs --include-rotations
 *                                    and map its exit code / structured stderr
 *                                    into the single-script exit contract that
 *                                    completion-verifier's `script`-type gate
 *                                    schema expects (exit 0 = pass,
 *                                    non-zero = fail). On FAIL the wrapper
 *                                    re-emits the script's stderr JSON verbatim
 *                                    so the gate finding surfaces the
 *                                    structured `error_code`
 *                                    (CHAIN_BROKEN / GENESIS_ANCHOR_INVALID /
 *                                    GENESIS_SIGNATURE_INVALID).
 *
 *   2. `verify-baseline-gate`      → import runPreflight() programmatically and
 *                                    gate the coercive-flip advance path on its
 *                                    result. Implements the ws-1 solo-ship
 *                                    advisory posture: `BASELINES_INCOMPLETE`
 *                                    during the partial rollout (ws-2 / ws-3
 *                                    baselines not yet published) is reported
 *                                    as an ADVISORY-ONLY notice on stderr and
 *                                    exits 0 so the completion-verifier gate
 *                                    does NOT block ws-1's own merge. Other
 *                                    structured rejections
 *                                    (SENTINEL_ACTIVE,
 *                                    BASELINE_SCHEMA_INVALID,
 *                                    BASELINE_INSUFFICIENT,
 *                                    BASELINE_RACE_ABORT,
 *                                    AUDIT_LOG_HEAD_UNREADABLE,
 *                                    ENFORCEMENT_FLAG_INVALID) remain genuine
 *                                    blockers → exit 2.
 *
 * Implements: REQ-014 (Task F4), REQ-017 (Task F5 — completion-verifier side)
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning / as-022
 * Parent: spec.md §Phase F Task F4/F5; §Flow 5; §Contract NFR-HASH-CHAIN-VERIFY
 *
 * Prerequisites (landed):
 *   - as-018: `.claude/scripts/verify-audit-chain.mjs --include-rotations`
 *     (exit 0/2 + structured stderr per spec.md:608-610)
 *   - as-020: `.claude/scripts/pipeline-efficiency-coercive-flip-preflight.mjs`
 *     (`runPreflight()` + PREFLIGHT_ERROR_CODES)
 *
 * Wire contract (consumer: `.claude/completion-gates.md` gates):
 *   - Both CLIs take no required arguments; they read canonical paths from the
 *     project root (resolved via CLAUDE_PROJECT_DIR or cwd).
 *   - Exit 0  → gate PASSED
 *   - Exit 2  → gate FAILED (blocking). stderr contains either the
 *               verify-audit-chain JSON envelope (verify-hash-chain) or a
 *               `REJECTED <CODE> <details>` line (verify-baseline-gate).
 *   - Exit 1  → UNEXPECTED wrapper error (also FAIL; surfaced as a script
 *               verification error — treated as blocking per the agent's
 *               Blocking Gates semantics, spec.md:336-345 of
 *               completion-verifier.md).
 *
 * Operational note (ws-1 solo-ship):
 *   During the ws-1 solo ship, only the ws-1 baseline exists at
 *   `.claude/metrics/pipeline-efficiency-ws1-baseline.json`. The 3-way baseline
 *   check emits `BASELINES_INCOMPLETE` in this state. Per dispatch guidance and
 *   the preflight's own operational contract (EC-9), this is expected: the
 *   completion-verifier gate SHOULD report advisory `NFR-WORKTREE-CANON
 *   partial — ws-3 as-021 pending` + `BASELINES_INCOMPLETE — ws-2/ws-3
 *   pending` WITHOUT blocking ws-1 merge. `verify-baseline-gate` implements
 *   this by exiting 0 on `BASELINES_INCOMPLETE` while still emitting the
 *   advisory notice to stderr so the finding surfaces in the completion
 *   verification report.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';

import {
  runPreflight,
  PREFLIGHT_ERROR_CODES,
} from './pipeline-efficiency-coercive-flip-preflight.mjs';

// =============================================================================
// Constants
// =============================================================================

/**
 * Sibling script path. Resolved relative to THIS file so the wrapper is
 * portable across worktrees (CLAUDE_PROJECT_DIR + cwd agree on the scripts
 * directory layout).
 */
const VERIFY_AUDIT_CHAIN_SCRIPT_BASENAME = 'verify-audit-chain.mjs';

/**
 * Timeout for the verify-audit-chain.mjs subprocess. Matches the
 * NFR-HASH-CHAIN-VERIFY contract (`timeout: 30s`, spec.md:588). Completion-
 * verifier must not hang on a wedged verify script.
 */
const VERIFY_AUDIT_CHAIN_TIMEOUT_MS = 30_000;

/** Exit codes — mirror the preflight's so the gate surface is consistent. */
const EXIT_OK = 0;
const EXIT_UNEXPECTED = 1;
const EXIT_FAIL = 2;

/**
 * Advisory-only rejection codes during the ws-1 solo ship.
 *
 * Per dispatch guidance: during the ws-1 solo ship, only the ws-1 baseline
 * exists. `BASELINES_INCOMPLETE` is expected (ws-2 / ws-3 pending); the
 * completion-verifier SHOULD surface this as an advisory notice rather than
 * blocking merge. Every other structured rejection code remains a genuine
 * blocker.
 *
 * When ws-2 and ws-3 ship, the partial-rollout window closes; at that point
 * the 3-way baseline gate becomes strictly blocking. An operator rolls the
 * advisory-only list back to the empty set with a follow-on spec (scope of
 * ws-3 integration, NOT ws-1 solo).
 */
const ADVISORY_ONLY_CODES_DURING_SOLO_SHIP = Object.freeze(
  new Set([PREFLIGHT_ERROR_CODES.BASELINES_INCOMPLETE])
);

// =============================================================================
// Helpers
// =============================================================================

/**
 * Resolve the project root. Prefer CLAUDE_PROJECT_DIR (hook context), fall
 * back to cwd. Same policy as the sibling verify-audit-chain.mjs
 * (line 649) and pipeline-efficiency-audit-log.mjs so wrapper / verifier /
 * appender agree.
 *
 * @returns {string}
 */
function resolveProjectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Absolute path to this file's directory — used to locate sibling scripts
 * without depending on cwd.
 *
 * @returns {string}
 */
function resolveScriptsDir() {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Was this file invoked directly (`node <path>`) vs imported as a module?
 *
 * @returns {boolean}
 */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  const thisFilePath = fileURLToPath(import.meta.url);
  const entryAbs = entry.startsWith(sep) ? entry : resolve(process.cwd(), entry);
  return thisFilePath === entryAbs;
}

// =============================================================================
// verify-hash-chain subcommand (Task F4 — REQ-014 / Flow 5)
// =============================================================================

/**
 * Spawn `verify-audit-chain.mjs --include-rotations` and propagate its
 * structured exit code.
 *
 * The verify script's stderr JSON envelope (spec: verify-audit-chain.mjs
 * lines 33-46) is passed through verbatim so downstream consumers (log
 * aggregators, the completion-verifier finding synthesizer) can parse the
 * structured `error_code` field.
 *
 * @returns {{ exitCode: number, stderr: string, stdout: string }}
 */
function runVerifyHashChain() {
  const scriptsDir = resolveScriptsDir();
  const scriptPath = resolve(scriptsDir, VERIFY_AUDIT_CHAIN_SCRIPT_BASENAME);

  // Preserve CLAUDE_PROJECT_DIR so the verify script resolves the same
  // genesis + log paths the wrapper sees.
  const env = { ...process.env };

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--include-rotations'],
    {
      encoding: 'utf-8',
      timeout: VERIFY_AUDIT_CHAIN_TIMEOUT_MS,
      env,
    }
  );

  // Spawn-level failure (ENOENT on node, timeout) — surface as unexpected.
  if (result.error) {
    const detail = `verify-audit-chain.mjs spawn failed: ${result.error.message}`;
    process.stderr.write(`UNEXPECTED verify-hash-chain ${detail}\n`);
    return {
      exitCode: EXIT_UNEXPECTED,
      stderr: detail,
      stdout: '',
    };
  }

  // Pass through the verify script's stderr (structured JSON envelope) and
  // stdout to the wrapper's own stderr / stdout. Completion-verifier consumer
  // parses the envelope for the `error_code` field to shape the finding.
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);

  // Map exit codes. verify-audit-chain uses:
  //   0 → PASS
  //   2 → structured FAIL
  // Anything else → unexpected (map to EXIT_UNEXPECTED so the operator can
  // distinguish structured-reject from wrapper-bug).
  const childExit =
    typeof result.status === 'number' ? result.status : EXIT_UNEXPECTED;

  if (childExit === 0) {
    return { exitCode: EXIT_OK, stderr: result.stderr || '', stdout: result.stdout || '' };
  }
  if (childExit === 2) {
    return { exitCode: EXIT_FAIL, stderr: result.stderr || '', stdout: result.stdout || '' };
  }

  // Unexpected child exit (e.g., 1 from an uncaught throw). Record as
  // wrapper-unexpected so the gate fails but the operator sees the
  // distinction in audit logs.
  process.stderr.write(
    `UNEXPECTED verify-hash-chain child exited with ${childExit}\n`
  );
  return {
    exitCode: EXIT_UNEXPECTED,
    stderr: result.stderr || '',
    stdout: result.stdout || '',
  };
}

// =============================================================================
// verify-baseline-gate subcommand (Task F5 — REQ-017 / EC-9)
// =============================================================================

/**
 * Run the 3-way baseline preflight programmatically and map its result to
 * the completion-verifier's gate surface.
 *
 * Per the ws-1 solo-ship advisory posture, `BASELINES_INCOMPLETE` is the
 * expected state until ws-2 and ws-3 ship their baselines. In this state the
 * wrapper emits an ADVISORY-ONLY stderr notice and exits 0. The advisory
 * notice text is crafted so a downstream log scanner can recognize it as a
 * structured message rather than noise.
 *
 * All other structured rejections remain blocking (exit 2).
 *
 * @param {{ projectRoot?: string }} [opts]
 * @returns {{ exitCode: number, advisory: boolean, result: object }}
 */
function runVerifyBaselineGate(opts = {}) {
  const projectRoot = opts.projectRoot || resolveProjectRoot();

  let result;
  try {
    result = runPreflight({ projectRoot });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(
      `UNEXPECTED verify-baseline-gate ${message}\n`
    );
    return {
      exitCode: EXIT_UNEXPECTED,
      advisory: false,
      result: { accepted: false, code: 'UNEXPECTED_ERROR', details: { message } },
    };
  }

  // Surface the substrate-probe warning (non-blocking) regardless of the
  // accept/reject outcome — it's a diagnostic that helps operators
  // understand WHY a baseline might be missing.
  if (result.substrate && result.substrate.mismatch) {
    process.stderr.write(`WARN verify-baseline-gate ${result.substrate.message}\n`);
  }

  if (result.accepted) {
    process.stdout.write(
      `ACCEPTED verify-baseline-gate all 3 baselines present and sufficient` +
        `\n`
    );
    return { exitCode: EXIT_OK, advisory: false, result };
  }

  // Rejected. Decide advisory-vs-blocking via the solo-ship allowlist.
  const code = result.code;
  const isAdvisoryOnly = ADVISORY_ONLY_CODES_DURING_SOLO_SHIP.has(code);

  if (isAdvisoryOnly) {
    // Emit structured advisory notices expected by the dispatch prompt:
    //   - NFR-WORKTREE-CANON partial — ws-3 as-021 pending
    //   - BASELINES_INCOMPLETE — ws-2/ws-3 pending
    const missingIds =
      (result.details && Array.isArray(result.details.missing_baselines)
        ? result.details.missing_baselines
        : [])
        .join(', ') || 'unknown';
    process.stderr.write(
      `ADVISORY verify-baseline-gate NFR-WORKTREE-CANON partial — ` +
        `ws-3 as-021 pending\n`
    );
    process.stderr.write(
      `ADVISORY verify-baseline-gate ${code} — ${missingIds} pending ` +
        `(ws-1 solo ship; non-blocking until ws-2/ws-3 ship)\n`
    );
    return { exitCode: EXIT_OK, advisory: true, result };
  }

  // Genuine blocker.
  const detailStr = JSON.stringify(result.details || {});
  process.stderr.write(
    `REJECTED verify-baseline-gate ${code} ${detailStr}\n`
  );
  return { exitCode: EXIT_FAIL, advisory: false, result };
}

// =============================================================================
// verify-worktree-env-parity subcommand (as-009 — REQ-007 / AC9.1)
// =============================================================================

/**
 * Pre-merge env-parity check for the completion-verifier gate.
 *
 * Spec: sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-009 / REQ-007 /
 *       AC9.1 (GIVEN completion-verifier runs pre-merge check WHEN
 *       `CLAUDE_PROJECT_DIR` differs from pin THEN check fails with
 *       WORKTREE_PATH_VIOLATION).
 *
 * Reads the session-pinned project dir via `loadProjectDirPin()` and calls
 * as-005's `enforceEnvParity()`. Three outcomes:
 *
 *   - Legacy session (no pin) → exit 0 (no enforcement). Matches the
 *     legacy-session guard set by as-008 for hooks.
 *   - Parity holds → exit 0.
 *   - Parity violated → audit-log entry emitted via `logWorktreeViolation`
 *     with `consumer: 'completion-verifier'`, then exit 2 with structured
 *     stderr message. AC9.2 is satisfied on this path.
 *
 * @param {{ projectRoot?: string }} [opts]
 * @returns {Promise<{ exitCode: number, audited?: boolean, result?: object }>}
 */
async function runVerifyWorktreeEnvParity(opts = {}) {
  // Lazy-import the as-008 shim + helper so this subcommand has no hard
  // dependency on the worktree-canon stack for the other subcommands.
  let shim;
  let helper;
  try {
    shim = await import('./lib/worktree-enforcement.mjs');
    helper = await import('./lib/worktree-canon-audit.mjs');
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(
      `UNEXPECTED verify-worktree-env-parity shim-import-failed ${message}\n`
    );
    return { exitCode: EXIT_UNEXPECTED };
  }

  // Legacy-session guard. loadProjectDirPin returns {pin: null} for sessions
  // started before as-006 shipped. The completion-verifier gate is opt-in to
  // enforcement; null pin → pass silently.
  const { pin } = shim.loadProjectDirPin({ projectRoot: opts.projectRoot });
  if (pin === null || pin === undefined) {
    process.stdout.write(
      'ACCEPTED verify-worktree-env-parity legacy-session (no pin captured)\n'
    );
    return { exitCode: EXIT_OK };
  }

  try {
    shim.enforceEnvParity(pin);
    process.stdout.write(
      `ACCEPTED verify-worktree-env-parity CLAUDE_PROJECT_DIR matches pin\n`
    );
    return { exitCode: EXIT_OK };
  } catch (err) {
    // Re-thrown from as-005 (or the local fallback). Shape per contract:
    //   { code, reason, attempted_path, pinned_root, exit_code }
    const reason = err && err.reason ? err.reason : 'unknown';
    const attemptedPath =
      err && err.attempted_path
        ? err.attempted_path
        : process.env.CLAUDE_PROJECT_DIR || '<unset>';
    const code = err && err.code ? err.code : 'WORKTREE_PATH_VIOLATION';

    // Emit the audit entry — completion-verifier is the last gate before
    // merge, so observability of a drifted session here is critical.
    // Best-effort; never throws.
    let auditResult;
    try {
      auditResult = await helper.logWorktreeViolation(
        {
          reason,
          attempted_path: attemptedPath,
          pinned_root: pin,
        },
        {
          consumer: 'completion-verifier',
          extras: { gate: 'pre-merge', check: 'env-parity' },
          projectRoot: opts.projectRoot,
        },
      );
    } catch (auditErr) {
      process.stderr.write(
        `WARN verify-worktree-env-parity audit-append-failed ${auditErr && auditErr.message}\n`
      );
      auditResult = { audited: false, error: auditErr && auditErr.message };
    }

    process.stderr.write(
      `REJECTED verify-worktree-env-parity ${code} ${JSON.stringify({ reason, attempted_path: attemptedPath, pinned_root: pin })}\n`
    );
    return { exitCode: EXIT_FAIL, audited: !!auditResult?.audited, result: { code, reason, attempted_path: attemptedPath, pinned_root: pin } };
  }
}

// =============================================================================
// CLI entrypoint
// =============================================================================

const USAGE =
  `Usage:\n` +
  `  node .claude/scripts/completion-verifier-hooks.mjs verify-hash-chain\n` +
  `  node .claude/scripts/completion-verifier-hooks.mjs verify-baseline-gate\n` +
  `  node .claude/scripts/completion-verifier-hooks.mjs verify-worktree-env-parity\n` +
  `  node .claude/scripts/completion-verifier-hooks.mjs verify-worktree-canon  (alias)\n`;

/**
 * Dispatch on the first positional argument.
 *
 * @param {string[]} argv
 * @returns {number}
 */
async function runCli(argv) {
  const positional = argv.slice(2).filter((a) => !a.startsWith('-'));
  const subcommand = positional[0];

  switch (subcommand) {
    case 'verify-hash-chain': {
      const { exitCode } = runVerifyHashChain();
      return exitCode;
    }
    case 'verify-baseline-gate': {
      const { exitCode } = runVerifyBaselineGate();
      return exitCode;
    }
    case 'verify-worktree-env-parity':
    case 'verify-worktree-canon': {
      // as-009: async because worktree-canon-audit helper is dynamic-imported
      // and `logWorktreeViolation` is async (appendAuditEntry lazy-load).
      // Two subcommand names are accepted for stability: `verify-worktree-
      // env-parity` describes the behavior (env-parity assertion); `verify-
      // worktree-canon` is the alias used by the test-writer contract in
      // .claude/scripts/__tests__/as-009-completion-verifier-audit-wiring.test.mjs.
      const { exitCode } = await runVerifyWorktreeEnvParity();
      return exitCode;
    }
    default: {
      process.stderr.write(
        `UNKNOWN subcommand ${JSON.stringify(subcommand)}\n${USAGE}`
      );
      return EXIT_UNEXPECTED;
    }
  }
}

if (isDirectInvocation()) {
  // runCli is async now (verify-worktree-env-parity path); await before exit.
  const code = await runCli(process.argv);
  process.exit(code);
}

// =============================================================================
// Exports for testing
// =============================================================================

export {
  runVerifyHashChain,
  runVerifyBaselineGate,
  runVerifyWorktreeEnvParity,
  runCli,
  ADVISORY_ONLY_CODES_DURING_SOLO_SHIP,
  VERIFY_AUDIT_CHAIN_SCRIPT_BASENAME,
  VERIFY_AUDIT_CHAIN_TIMEOUT_MS,
  EXIT_OK,
  EXIT_UNEXPECTED,
  EXIT_FAIL,
};
