#!/usr/bin/env node

/**
 * Pre-Merge-Verify Top-Level CLI Entry-Point (sg-pre-merge-verify-20260508 / AS-5).
 *
 * Thin orchestrator wrapper that:
 *   1. Resolves the worktree root (CLAUDE_PROJECT_DIR or cwd).
 *   2. Reads `package.json` to determine the consumer command contract.
 *   3. Resolves the active spec_group_id (positional, --sg-id, or
 *      session.active_work.spec_group_id).
 *   4. Invokes `runPreMergeVerify` from `lib/pre-merge-verify.mjs`.
 *   5. Persists the discriminated-union result via the
 *      `record-pre-merge-verify-result` CLI subcommand on
 *      `session-checkpoint.mjs` (NFR-2 sole-writer for `session.pre_merge_verify`).
 *   6. Exits 0 on `passed` | `skipped`, 1 on `failed`.
 *
 * Stdout: JSON summary `{result, reason, audit_seq, dispatch_id}`.
 * Stderr: narrative diagnostics.
 *
 * CLI shape:
 *   pre-merge-verify [<spec_group_id>] [--sg-id <id>] [--cwd <path>]
 *                    [--dispatch-id <id>] [--session-id <id>]
 *
 * Per AS-5 outcome: this script is the operator/Stop-hook entry-point. The
 * orchestrator library at `lib/pre-merge-verify.mjs` is the implementation.
 * The split mirrors `compute-hashes.mjs` (top-level CLI) → library helpers.
 *
 * Spec: sg-pre-merge-verify-20260508 / AS-5 (CLI surface) + AS-6
 * (record-pre-merge-verify-result persistence).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { runPreMergeVerify } from './lib/pre-merge-verify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse positional + flag args. Positional first arg (if not flag-prefixed) is
 * treated as `spec_group_id`. Flags override.
 *
 * @param {string[]} argv
 * @returns {{specGroupId: string|null, cwd: string|null, dispatchId: string|null, sessionId: string|null, help: boolean}}
 */
function parseArgs(argv) {
  const args = {
    specGroupId: null,
    cwd: null,
    dispatchId: null,
    sessionId: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('--sg-id=')) {
      args.specGroupId = arg.slice('--sg-id='.length);
    } else if (arg === '--sg-id') {
      args.specGroupId = argv[++i] || null;
    } else if (arg.startsWith('--cwd=')) {
      args.cwd = arg.slice('--cwd='.length);
    } else if (arg === '--cwd') {
      args.cwd = argv[++i] || null;
    } else if (arg.startsWith('--dispatch-id=')) {
      args.dispatchId = arg.slice('--dispatch-id='.length);
    } else if (arg === '--dispatch-id') {
      args.dispatchId = argv[++i] || null;
    } else if (arg.startsWith('--session-id=')) {
      args.sessionId = arg.slice('--session-id='.length);
    } else if (arg === '--session-id') {
      args.sessionId = argv[++i] || null;
    } else if (!arg.startsWith('--') && args.specGroupId === null) {
      // Positional: first non-flag argument is spec_group_id.
      args.specGroupId = arg;
    }
  }
  return args;
}

function printHelp() {
  process.stderr.write(
    [
      'Usage: pre-merge-verify [<spec_group_id>] [options]',
      '',
      'Top-level CLI for the pre-merge-verify Stop-hook gate orchestrator.',
      'Boots a consumer fixture, probes health-bearing routes per the deployment',
      'manifest, and persists the discriminated-union result to session.pre_merge_verify.',
      '',
      'Options:',
      '  --sg-id <id>          Spec group id (overrides positional). Falls back to',
      '                        session.active_work.spec_group_id when omitted.',
      '  --cwd <path>          Worktree root (defaults to CLAUDE_PROJECT_DIR or cwd).',
      '  --dispatch-id <id>    Free-form dispatch id for audit-chain tagging.',
      '  --session-id <id>     Session id (defaults to derived from session.json).',
      '  --help, -h            Show this help.',
      '',
      'Exit codes:',
      '  0   pre-merge-verify result is "passed" or "skipped"',
      '  1   pre-merge-verify result is "failed"',
      '  2   structural error (missing package.json, no active_work, etc.)',
      '',
      'Spec: sg-pre-merge-verify-20260508 / AS-5.',
      '',
    ].join('\n')
  );
}

// ---------------------------------------------------------------------------
// Worktree + session resolution
// ---------------------------------------------------------------------------

function resolveWorktreeRoot(cliCwd) {
  if (cliCwd && typeof cliCwd === 'string' && cliCwd.length > 0) {
    return resolve(cliCwd);
  }
  const projectRoot = process.env.CLAUDE_PROJECT_DIR;
  if (projectRoot && typeof projectRoot === 'string' && projectRoot.length > 0) {
    return resolve(projectRoot);
  }
  return resolve(process.cwd());
}

function readPackageJson(worktreeRoot) {
  const pkgPath = join(worktreeRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `[pre-merge-verify] WARNING: failed to parse ${pkgPath}: ${err.message}\n`
    );
    return null;
  }
}

function readSessionJson(worktreeRoot) {
  const sessionPath = join(worktreeRoot, '.claude', 'context', 'session.json');
  if (!existsSync(sessionPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(sessionPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `[pre-merge-verify] WARNING: failed to parse ${sessionPath}: ${err.message}\n`
    );
    return null;
  }
}

/**
 * Resolve spec_group_id by precedence: CLI arg > session.active_work > error.
 *
 * @param {string|null} cliSpecGroupId
 * @param {object|null} session
 * @returns {string|null}
 */
function resolveSpecGroupId(cliSpecGroupId, session) {
  if (cliSpecGroupId && typeof cliSpecGroupId === 'string' && cliSpecGroupId.trim() !== '') {
    return cliSpecGroupId.trim();
  }
  const fromSession = session?.active_work?.spec_group_id;
  if (typeof fromSession === 'string' && fromSession.trim() !== '') {
    return fromSession.trim();
  }
  return null;
}

/**
 * Generate a dispatch id when one is not provided. Free-form per DEC-LOW.
 */
function generateDispatchId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `pre-merge-verify-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Result persistence (record-pre-merge-verify-result CLI subcommand)
// ---------------------------------------------------------------------------

/**
 * Persist the orchestrator's discriminated-union result to
 * `session.pre_merge_verify` via the trusted writer (NFR-2 sole-writer).
 *
 * Spawns `session-checkpoint.mjs record-pre-merge-verify-result` against the
 * same sandbox (CLAUDE_PROJECT_DIR honored). Failure to persist is reported
 * to stderr but does NOT change the orchestrator's exit-code policy — the
 * gate decision is the orchestrator result, not the persistence success.
 *
 * @param {object} args
 * @param {string} args.specGroupId
 * @param {string} args.status            "passed" | "failed" | "skipped"
 * @param {string|null} args.reason       Closed-enum reason; null only when status === "passed"
 * @param {number|null} args.auditSeq
 * @param {string|null} args.dispatchId
 * @param {number|null} args.cumulativeMs
 * @param {object|null} args.evidence     Captured InfraBlocked-shaped evidence (for failed)
 * @param {string} args.worktreeRoot
 * @returns {{recorded: boolean, narrative: string|null}}
 */
function persistResult(args) {
  const {
    specGroupId,
    status,
    reason,
    auditSeq,
    dispatchId,
    cumulativeMs,
    evidence,
    worktreeRoot,
  } = args;

  const checkpointCli = resolve(__dirname, 'session-checkpoint.mjs');
  if (!existsSync(checkpointCli)) {
    return {
      recorded: false,
      narrative: `session-checkpoint.mjs not found at ${checkpointCli}`,
    };
  }

  const cliArgs = [
    checkpointCli,
    'record-pre-merge-verify-result',
    specGroupId,
    '--status',
    status,
    '--reason',
    reason === null || reason === undefined ? 'null' : String(reason),
  ];
  if (Number.isInteger(auditSeq)) {
    cliArgs.push('--audit-seq', String(auditSeq));
  }
  if (typeof dispatchId === 'string' && dispatchId.trim() !== '') {
    cliArgs.push('--dispatch-id', dispatchId);
  }
  if (Number.isInteger(cumulativeMs)) {
    cliArgs.push('--cumulative-ms', String(cumulativeMs));
  }
  // BUG-FIX-2026-05-09 (Bug 2): persist inline structured evidence via
  // `--evidence <json>` so AC-13.1/AC-13.2 INFRA_BLOCKED-bucket trigger
  // evidence (timestamp, narrative, exception_trace?, dispatch_id, session_id)
  // lands in `session.pre_merge_verify.evidence` and the audit-chain history
  // entry. The session-checkpoint validator gates the payload (proto-pollution
  // defense + length caps + control-char strip).
  if (
    evidence !== null &&
    evidence !== undefined &&
    typeof evidence === 'object' &&
    !Array.isArray(evidence)
  ) {
    try {
      cliArgs.push('--evidence', JSON.stringify(evidence));
    } catch (err) {
      process.stderr.write(
        `[pre-merge-verify] WARNING: failed to serialize evidence JSON; persisting status+reason only: ${err.message}\n`
      );
    }
  }

  try {
    execFileSync(process.execPath, cliArgs, {
      cwd: worktreeRoot,
      env: { ...process.env, CLAUDE_PROJECT_DIR: worktreeRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { recorded: true, narrative: null };
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException & {stderr?: Buffer; stdout?: Buffer; status?: number}} */ (err);
    const stderrText = e.stderr ? e.stderr.toString('utf-8') : e.message || String(err);
    return {
      recorded: false,
      narrative: `record-pre-merge-verify-result failed (exit=${e.status ?? -1}): ${stderrText}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const worktreeRoot = resolveWorktreeRoot(args.cwd);
  const packageJson = readPackageJson(worktreeRoot);

  if (!packageJson) {
    process.stderr.write(
      `[pre-merge-verify] ERROR: package.json not found or unreadable at ${worktreeRoot}/package.json\n`
    );
    process.exit(2);
  }

  const session = readSessionJson(worktreeRoot);
  const specGroupId = resolveSpecGroupId(args.specGroupId, session);

  if (!specGroupId) {
    process.stderr.write(
      '[pre-merge-verify] ERROR: spec_group_id not provided and not present in ' +
        'session.active_work.spec_group_id. Pass as positional arg or --sg-id.\n'
    );
    process.exit(2);
  }

  const dispatchId = args.dispatchId || generateDispatchId();
  const sessionId =
    args.sessionId ||
    (typeof session?.session_id === 'string' && session.session_id) ||
    `session-${Date.now()}`;

  process.stderr.write(
    `[pre-merge-verify] Starting: spec_group_id=${specGroupId} dispatch_id=${dispatchId} ` +
      `worktree=${worktreeRoot}\n`
  );

  let runResult;
  let cumulativeMs = null;
  const startMs = Date.now();
  try {
    runResult = await runPreMergeVerify({
      specGroupId,
      dispatchId,
      sessionId,
      worktreeRoot,
      packageJson,
      // The orchestrator infers Stop-hook vs manual-vibe at the dispatch
      // boundary; this CLI is invoked manually (operator command, /pre-merge-verify
      // skill, or test harness), not by the Stop-hook itself. Keep the default
      // (false = stop_hook) so audit entries record dispatch_mode consistently
      // with the contract — the Stop-hook NEVER spawns this CLI; in-process
      // dispatch goes through the agent layer.
      dispatchedManually: false,
    });
    cumulativeMs = Date.now() - startMs;
  } catch (err) {
    cumulativeMs = Date.now() - startMs;
    process.stderr.write(
      `[pre-merge-verify] ERROR: orchestrator threw: ${err?.message || String(err)}\n` +
        (err?.stack ? `${err.stack}\n` : '')
    );
    // Persist a structural failure so the Stop-hook sees it.
    const persist = persistResult({
      specGroupId,
      status: 'failed',
      reason: 'audit_chain_tamper_detected',
      auditSeq: null,
      dispatchId,
      cumulativeMs,
      evidence: { narrative: err?.message || String(err) },
      worktreeRoot,
    });
    if (!persist.recorded) {
      process.stderr.write(
        `[pre-merge-verify] WARNING: failed to persist structural error: ${persist.narrative}\n`
      );
    }
    process.exit(2);
  }

  const { result, reason, evidence, audit_seq: auditSeq } = runResult;

  // Persist via the trusted writer (NFR-2 sole-writer).
  const persist = persistResult({
    specGroupId,
    status: result,
    reason: reason ?? null,
    auditSeq: typeof auditSeq === 'number' ? auditSeq : null,
    dispatchId,
    cumulativeMs,
    evidence: evidence ?? null,
    worktreeRoot,
  });

  if (!persist.recorded) {
    process.stderr.write(
      `[pre-merge-verify] WARNING: failed to persist result via record-pre-merge-verify-result: ${persist.narrative}\n`
    );
  }

  // Stdout: JSON summary on a single line for machine consumption.
  process.stdout.write(
    JSON.stringify({
      result,
      reason: reason ?? null,
      audit_seq: typeof auditSeq === 'number' ? auditSeq : null,
      dispatch_id: dispatchId,
      cumulative_ms: cumulativeMs,
      persisted: persist.recorded,
    }) + '\n'
  );

  // Stderr: human narrative.
  process.stderr.write(
    `[pre-merge-verify] result=${result} reason=${reason ?? '<none>'} ` +
      `audit_seq=${auditSeq ?? '<none>'} cumulative_ms=${cumulativeMs}\n`
  );

  // Exit policy: passed/skipped → 0; failed → 1.
  if (result === 'passed' || result === 'skipped') {
    process.exit(0);
  }
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(
    `[pre-merge-verify] FATAL: unhandled rejection: ${err?.message || String(err)}\n` +
      (err?.stack ? `${err.stack}\n` : '')
  );
  process.exit(2);
});
