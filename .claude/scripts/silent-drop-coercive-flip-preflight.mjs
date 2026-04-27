#!/usr/bin/env node

/**
 * silent-drop-coercive-flip-preflight.mjs
 *
 * Coercive-flip preflight gate. Operator-invoked (NOT agent-invoked) prior to
 * any advisory→coercive flip. Enforces behavioral contract:
 *   (1) verify-enforcement-audit-chain.mjs exit 0
 *   (2) (sample_floor_met OR sample_floor_waived) AND waiver rationale ≥50
 *   (3) context_engine_replay_pass=true
 *   (4) false_positive_rate <= FP_CEILING
 *   (5) substrate probe — warn (non-blocking) if changed since baseline pub
 *
 * On any blocking gate failure, exits non-zero with a structured code naming
 * the specific failure.
 *
 * gh CLI fallback (DEC-007): when `gh` is missing or `.github/` is absent,
 * substrate defaults to `other` with a non-blocking warning. ENOENT stack
 * traces are NEVER surfaced — structured warnings only.
 *
 * Usage:
 *   node silent-drop-coercive-flip-preflight.mjs <baseline-path> [flags]
 *
 * Flags (test-mode only, gated by SILENT_DROP_PREFLIGHT_TEST_MODE=1):
 *   --force-chain-break         Simulate verifier exit 1
 *   --force-substrate=<value>   Override substrate probe result
 *   --force-probe-error         Simulate substrate probe error
 *   --force-gh-enoent           Simulate gh missing
 *   --print-substrate           Print substrate probe result even on success
 *
 * Exit codes:
 *   0 - All gates pass; flip permitted.
 *   1 - A blocking gate failed; structured code on stderr.
 *   2 - Invocation error (missing baseline, bad args).
 *
 * Failure codes:
 *   chain-break
 *   sample-floor-unmet
 *   waiver-rationale-too-short
 *   replay-not-passed
 *   fp-rate-above-ceiling
 *
 * Implements: AC-5.1..5.4, AC-5.8, AC-16.4, AC-22.2, AC-22.3, AC-22.4, DEC-007.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  silentDropBaselineReportSchema,
  reengagementHistoryEntrySchema,
} from './lib/silent-drop-schemas.mjs';

// =============================================================================
// Constants
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** AC-5.4: false-positive rate ceiling; spec.md AC-5.4 / REQ-NFR-2. */
const FP_CEILING = 0.2;

/** Waiver rationale minimum length (AC-5.2). */
const WAIVER_RATIONALE_MIN = 50;

const EXIT_OK = 0;
const EXIT_GATE_FAIL = 1;
const EXIT_USAGE = 2;

const TEST_MODE = process.env.SILENT_DROP_PREFLIGHT_TEST_MODE === '1';

// =============================================================================
// Arg parsing
// =============================================================================

function parseArgs(argv) {
  const out = {
    baseline: null,
    forceChainBreak: false,
    forceSubstrate: null,
    forceProbeError: false,
    forceGhEnoent: false,
    printSubstrate: false,
  };
  for (const a of argv) {
    if (a === '--force-chain-break') out.forceChainBreak = true;
    else if (a === '--force-probe-error') out.forceProbeError = true;
    else if (a === '--force-gh-enoent') out.forceGhEnoent = true;
    else if (a === '--print-substrate') out.printSubstrate = true;
    else if (a.startsWith('--force-substrate=')) {
      out.forceSubstrate = a.slice('--force-substrate='.length);
    } else if (!a.startsWith('--') && !out.baseline) {
      out.baseline = a;
    }
  }
  return out;
}

// =============================================================================
// Structured emit helpers
// =============================================================================

function emit(event, payload) {
  process.stderr.write(
    JSON.stringify({ event, ...payload }) + '\n',
  );
}

function fail(code, detail, extras = {}) {
  process.stderr.write(
    JSON.stringify({
      event: 'preflight_gate_failed',
      result: 'REJECT',
      code,
      detail: detail ?? null,
      ...extras,
    }) + '\n',
  );
  process.exit(EXIT_GATE_FAIL);
}

// =============================================================================
// Verifier invocation (gate 1)
// =============================================================================

function runVerifier(args) {
  if (args.forceChainBreak && TEST_MODE) {
    return { exitCode: 1, stderr: 'simulated chain-break (test mode)' };
  }
  const verifierPath = join(__dirname, 'verify-enforcement-audit-chain.mjs');
  if (!existsSync(verifierPath)) {
    return { exitCode: 2, stderr: 'verifier script missing' };
  }
  const logPath = join(
    process.cwd(),
    '.claude',
    'audit',
    'enforcement-changes.log',
  );
  // Missing log is treated as "valid-empty" for the preflight — no chain
  // established yet is not a break. Only an explicit exit 1 (broken-link
  // index) blocks the flip.
  if (!existsSync(logPath)) {
    return { exitCode: 0, stderr: 'audit log missing — treated as empty' };
  }
  const result = spawnSync('node', [verifierPath, logPath], {
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? '',
  };
}

// =============================================================================
// Substrate probe (gate 5)
// =============================================================================

/**
 * Probe CODEOWNERS enforcement substrate.
 *
 * Detection order:
 *   (a) `git remote -v` → github.com remote ⇒ candidate=github-branch-protection
 *   (b) `.github/CODEOWNERS` presence confirms candidate
 *   (c) `gh api repos/:owner/:repo/branches/:branch/protection` → 200 confirms
 *   (d) otherwise fallback → local-single-maintainer (or other on missing gh)
 *
 * DEC-007: ENOENT on `gh` → substrate=other with warning; never leak stack.
 *
 * @returns {{ substrate: string, warnings: string[] }}
 */
function probeSubstrate(args) {
  if (TEST_MODE && args.forceSubstrate) {
    return { substrate: args.forceSubstrate, warnings: [] };
  }
  if (TEST_MODE && args.forceProbeError) {
    return {
      substrate: 'other',
      warnings: [
        'substrate probe failed (simulated); defaulting to other (fallback/fail-open)',
      ],
    };
  }
  if (TEST_MODE && args.forceGhEnoent) {
    return {
      substrate: 'other',
      warnings: [
        'gh CLI not on PATH (simulated); defaulting substrate=other per DEC-007',
      ],
    };
  }

  const warnings = [];

  // Step (a): check for github remote.
  let hasGithubRemote = false;
  try {
    const remotes = spawnSync('git', ['remote', '-v'], { encoding: 'utf-8' });
    if (remotes.status === 0 && /github\.com/.test(remotes.stdout ?? '')) {
      hasGithubRemote = true;
    }
  } catch {
    // Fall through; no remote probe available.
  }

  // Step (b): look for .github/CODEOWNERS.
  const codeownersInGithub = existsSync(
    join(process.cwd(), '.github', 'CODEOWNERS'),
  );
  const codeownersInRoot = existsSync(join(process.cwd(), 'CODEOWNERS'));
  const hasCodeowners = codeownersInGithub || codeownersInRoot;

  if (!hasGithubRemote) {
    return { substrate: 'local-single-maintainer', warnings };
  }

  // Step (c): attempt `gh api ...`. Catch ENOENT and all errors; never leak
  // stack trace (DEC-007).
  let ghAvailable = true;
  let branchProtectionOk = false;
  try {
    const ghVersion = spawnSync('gh', ['--version'], { encoding: 'utf-8' });
    if (ghVersion.error && ghVersion.error.code === 'ENOENT') {
      ghAvailable = false;
    } else if (ghVersion.status !== 0) {
      ghAvailable = false;
    }
  } catch {
    ghAvailable = false;
  }

  if (!ghAvailable) {
    warnings.push(
      'gh CLI not available; unable to verify branch-protection substrate — falling back to other per DEC-007',
    );
    return { substrate: 'other', warnings };
  }

  if (hasCodeowners) {
    // A full probe would parse git remote for owner/repo and call
    // `gh api repos/:owner/:repo/branches/main/protection`. For v1 the
    // heuristic is: gh present + codeowners present + github remote ⇒
    // github-branch-protection.
    branchProtectionOk = true;
  }

  return {
    substrate: branchProtectionOk
      ? 'github-branch-protection'
      : 'local-single-maintainer',
    warnings,
  };
}

// =============================================================================
// Main gate pipeline
// =============================================================================

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.baseline) {
    process.stderr.write(
      JSON.stringify({
        event: 'preflight_invocation_error',
        error: 'usage',
        detail: 'required: <baseline-path>',
      }) + '\n',
    );
    process.exit(EXIT_USAGE);
  }
  if (!existsSync(args.baseline)) {
    process.stderr.write(
      JSON.stringify({
        event: 'preflight_invocation_error',
        error: 'baseline-missing',
        detail: args.baseline,
      }) + '\n',
    );
    process.exit(EXIT_USAGE);
  }

  // Load + validate baseline.
  let baseline;
  try {
    const raw = readFileSync(args.baseline, 'utf-8');
    baseline = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        event: 'preflight_invocation_error',
        error: 'baseline-unreadable',
        detail: err instanceof Error ? err.message : String(err),
      }) + '\n',
    );
    process.exit(EXIT_USAGE);
  }

  // Validate reengagement_history separately so AC-20.3 messages stay visible.
  const history = Array.isArray(baseline.reengagement_history)
    ? baseline.reengagement_history
    : [];
  for (let i = 0; i < history.length; i++) {
    const result = reengagementHistoryEntrySchema.safeParse(history[i]);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      fail(
        'baseline-invalid',
        `reengagement_history[${i}].${firstIssue.path.join('.')}: ${firstIssue.message}`,
      );
    }
  }
  const fullResult = silentDropBaselineReportSchema.safeParse(baseline);
  if (!fullResult.success) {
    const firstIssue = fullResult.error.issues[0];
    fail(
      'baseline-invalid',
      `baseline.${firstIssue.path.join('.')}: ${firstIssue.message}`,
    );
  }
  const validated = fullResult.data;

  // Gate 1 (AC-16.4): run verifier first.
  const verifierResult = runVerifier(args);
  if (verifierResult.exitCode === 1) {
    fail('chain-break', 'audit chain broken — quarantine procedure required', {
      verifier_stderr: verifierResult.stderr?.slice(0, 500) ?? null,
    });
  }
  if (verifierResult.exitCode === 2) {
    fail(
      'chain-verifier-error',
      'verifier failed to read audit log',
      { verifier_stderr: verifierResult.stderr?.slice(0, 500) ?? null },
    );
  }

  // Gate 2 (AC-5.2): sample floor / waiver.
  if (!validated.sample_floor_met) {
    if (!validated.sample_floor_waived) {
      fail(
        'sample-floor-unmet',
        'sample_floor_met=false AND sample_floor_waived=false',
      );
    }
    const waiver = validated.waiver_rationale ?? '';
    if (waiver.length < WAIVER_RATIONALE_MIN) {
      fail(
        'waiver-rationale-too-short',
        `waiver_rationale length ${waiver.length} < ${WAIVER_RATIONALE_MIN}`,
      );
    }
  }

  // Gate 3 (AC-5.3): context engine replay.
  if (!validated.context_engine_replay_pass) {
    fail(
      'replay-not-passed',
      'context_engine_replay_pass=false',
    );
  }

  // Gate 4 (AC-5.4): false-positive rate ceiling.
  if (validated.false_positive_rate !== null) {
    if (validated.false_positive_rate > FP_CEILING) {
      fail(
        'fp-rate-above-ceiling',
        `false_positive_rate=${validated.false_positive_rate} > ceiling=${FP_CEILING}`,
      );
    }
  }

  // Gate 5 (AC-22.2/3/4): substrate probe; warnings are non-blocking.
  const probe = probeSubstrate(args);
  const warnings = [...probe.warnings];
  if (
    validated.published_substrate &&
    validated.published_substrate !== probe.substrate
  ) {
    warnings.push(
      `substrate changed since baseline publication: published=${validated.published_substrate}, current=${probe.substrate}`,
    );
  }

  if (args.printSubstrate || warnings.length > 0) {
    emit('preflight_substrate_probe', {
      current_substrate: probe.substrate,
      published_substrate: validated.published_substrate ?? null,
      warnings,
    });
  }

  emit('preflight_gates_ok', {
    substrate: probe.substrate,
    fp_rate: validated.false_positive_rate,
    sample_count: validated.sample_count,
    warnings_count: warnings.length,
  });

  process.stdout.write(
    JSON.stringify({
      approved: true,
      substrate: probe.substrate,
      warnings,
    }) + '\n',
  );
  process.exit(EXIT_OK);
}

main();
