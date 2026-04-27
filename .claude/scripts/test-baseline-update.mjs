#!/usr/bin/env node

/**
 * test-baseline-update: operator-explicit CLI to add/remove entries from
 * `.claude/test-baseline.json` with visible diff summary and atomic write.
 *
 * Test-baseline operator-update contract.
 * Covers ACs:
 *   - AC1.1: CLI shows diff summary (entries added / entries removed) before writing.
 *   - AC1.2: Baseline does NOT auto-update; requires `--confirm`.
 *   - AC1.3: Write uses `atomicWriteSentinel` (tmp + rename) per REQ-010.1.
 *
 * Rationale:
 *   The update path exists for operator-initiated baseline adjustments that
 *   are distinct from the automated `--refresh` recompute in
 *   `test-baseline-check.mjs`. Typical callers:
 *     (a) An operator manually marking a flaky test as baseline with a
 *         specific reason tag after triage.
 *     (b) Removing a stale entry that --refresh missed (e.g., file renamed).
 *
 * Invocation:
 *   node .claude/scripts/test-baseline-update.mjs \
 *        --add <file>::<test> \
 *        --remove <file>::<test> \
 *        --reason <tag> \
 *        [--confirm]
 *
 * Multiple `--add` / `--remove` flags are allowed. `--reason` applies to all
 * `--add` entries in the invocation and defaults to `operator-added` when
 * omitted. `--file-test-separator` defaults to `::`; override if a test name
 * contains the literal separator.
 *
 * Without `--confirm`, the CLI prints the diff summary and exits non-zero
 * with a reminder that confirmation is required. This is the dry-run form.
 *
 * Exit codes:
 *   0  Success (either --confirm write OR dry-run preview with no ops)
 *   1  Confirmation required (dry-run with pending ops)
 *   2  Fail-closed (corrupt baseline / schema violation)
 *   3  Argument misuse (missing file, unknown flag, conflicting ops)
 *   4  Write failed (atomic rename error, etc.)
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteSentinel } from './lib/atomic-write.mjs';
import { getCanonicalProjectDir } from './lib/hook-utils.mjs';
import {
  SUPPORTED_VERSION,
  TestBaselineError,
  entryKey,
  loadBaselineFile,
} from './lib/test-baseline-schema.mjs';
import { resolveRepoRoot } from './lib/test-run.mjs';

/**
 * Resolve the project root. Prefer `getCanonicalProjectDir()` (AS-012 sole
 * authorized env reader); fall back to script-relative repo root when
 * invoked standalone without `CLAUDE_PROJECT_DIR`.
 */
function resolveProjectDir() {
  try {
    return getCanonicalProjectDir();
  } catch {
    return resolveRepoRoot();
  }
}

function defaultBaselinePath() {
  return resolve(resolveProjectDir(), '.claude', 'test-baseline.json');
}

// =============================================================================
// CLI parsing
// =============================================================================

/**
 * Parse `--add <file>::<test>` and `--remove <file>::<test>` pairs plus
 * `--reason <tag>` + `--confirm` + optional `--baseline=<path>` +
 * `--file-test-separator=<sep>`.
 *
 * Exported for unit tests.
 */
/**
 * Parse CLI args. Supports two forms for add/remove entries:
 *
 *   Two-flag form (test-writer contract):
 *     --add <file>   --test <testname>   [--reason <tag>]
 *     --remove <file> --test <testname>
 *
 *   Combined form (operator convenience):
 *     --add <file>::<test>     [--reason <tag>]
 *     --remove <file>::<test>
 *
 * The two-flag form pairs the most recent `--add`/`--remove` flag with the
 * next `--test`. Multiple pairs may be supplied by repeating the flags in
 * the same order. Mixing forms in one invocation is allowed; each `--add`
 * value that contains the configured separator is treated as a combined
 * pair and does not consume a trailing `--test`.
 */
export function parseArgs(argv) {
  const args = {
    adds: /** @type {Array<{file: string, test: string}>} */ ([]),
    removes: /** @type {Array<{file: string, test: string}>} */ ([]),
    reason: 'operator-added',
    confirm: false,
    baselinePath: null,
    separator: '::',
    help: false,
  };

  // Pre-pass: resolve the separator so combined-form args parse consistently.
  for (const tok of argv) {
    if (tok.startsWith('--file-test-separator=')) {
      args.separator = tok.slice('--file-test-separator='.length);
      if (args.separator.length === 0) {
        throw new TestBaselineError('--file-test-separator cannot be empty', 'arg_misuse');
      }
    }
  }

  /**
   * `pending` tracks the most recent --add/--remove flag that is waiting for
   * a `--test` value to complete the pair. When a subsequent --add/--remove
   * arrives before --test, the pending flag's value must have been in
   * combined form; otherwise the parse errors.
   */
  let pending = null; // { kind: 'add'|'remove', file: string } | null

  const flushPending = () => {
    if (pending) {
      throw new TestBaselineError(
        `--${pending.kind} ${pending.file} is missing a --test pair`,
        'arg_misuse',
      );
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') {
      args.help = true;
    } else if (tok === '--confirm') {
      args.confirm = true;
    } else if (tok === '--reason') {
      if (i + 1 >= argv.length) {
        throw new TestBaselineError('--reason requires a value', 'arg_misuse');
      }
      args.reason = argv[++i];
    } else if (tok.startsWith('--reason=')) {
      args.reason = tok.slice('--reason='.length);
    } else if (tok.startsWith('--baseline=')) {
      args.baselinePath = tok.slice('--baseline='.length);
    } else if (tok.startsWith('--file-test-separator=')) {
      // handled in pre-pass
      continue;
    } else if (tok === '--add' || tok === '--remove') {
      flushPending();
      if (i + 1 >= argv.length) {
        throw new TestBaselineError(`${tok} requires a value`, 'arg_misuse');
      }
      const value = argv[++i];
      const sepIndex = value.indexOf(args.separator);
      if (sepIndex >= 0) {
        // Combined form: file+separator+test in one value.
        const file = value.slice(0, sepIndex);
        const test = value.slice(sepIndex + args.separator.length);
        if (!file || !test) {
          throw new TestBaselineError(
            `${tok} value has empty file or test: ${value}`,
            'arg_misuse',
          );
        }
        if (tok === '--add') args.adds.push({ file, test });
        else args.removes.push({ file, test });
      } else {
        // Two-flag form: remember the flag; expect a --test next.
        pending = { kind: tok === '--add' ? 'add' : 'remove', file: value };
      }
    } else if (tok === '--test') {
      if (i + 1 >= argv.length) {
        throw new TestBaselineError('--test requires a value', 'arg_misuse');
      }
      if (!pending) {
        throw new TestBaselineError(
          '--test must follow a prior --add <file> or --remove <file>',
          'arg_misuse',
        );
      }
      const testName = argv[++i];
      const entry = { file: pending.file, test: testName };
      if (pending.kind === 'add') args.adds.push(entry);
      else args.removes.push(entry);
      pending = null;
    } else if (tok.startsWith('--')) {
      throw new TestBaselineError(`unknown flag: ${tok}`, 'arg_misuse');
    } else {
      throw new TestBaselineError(`unexpected argument: ${tok}`, 'arg_misuse');
    }
  }
  flushPending();
  return args;
}

function printHelp(stream = process.stdout) {
  stream.write(
    [
      'Usage: test-baseline-update [--add <file>::<test>]... [--remove <file>::<test>]...',
      '                            [--reason <tag>] [--confirm] [--baseline=<path>]',
      '                            [--file-test-separator=<sep>]',
      '',
      'Operator-explicit CLI for adjusting .claude/test-baseline.json with a visible',
      'diff summary. Writes use atomic tmp+rename (REQ-010.1).',
      '',
      'Modes:',
      '  Without --confirm  Dry-run; prints diff summary, exits 1.',
      '  With --confirm     Applies diff, writes atomically, exits 0.',
      '',
      'Exit codes:',
      '  0  Success (confirmed write OR no-op dry-run)',
      '  1  Confirmation required (pending ops without --confirm)',
      '  2  Corrupt baseline / schema violation',
      '  3  Argument misuse',
      '  4  Write failed',
    ].join('\n') + '\n',
  );
}

// =============================================================================
// Diff planning
// =============================================================================

/**
 * Compute the proposed-next baseline given the current baseline + add/remove
 * requests. Produces the diff summary needed for operator review.
 *
 * Duplicate-add semantics: requesting to add an entry that already exists
 * in the baseline is a no-op (not an error). Requesting to remove an entry
 * that does not exist in the baseline is also a no-op. This matches the
 * idempotence requirement (NFR-6): running the same update twice yields the
 * same state.
 */
export function planUpdate(baseline, adds, removes, reason) {
  const now = new Date().toISOString();
  const keys = new Map(baseline.entries.map((e) => [entryKey(e), e]));
  const actuallyAdded = [];
  const actuallyRemoved = [];
  const skippedAdds = [];
  const skippedRemoves = [];

  for (const a of adds) {
    const k = entryKey(a);
    if (keys.has(k)) {
      skippedAdds.push(a);
    } else {
      const entry = {
        file: a.file,
        test: a.test,
        reason,
        added_date: now,
      };
      keys.set(k, entry);
      actuallyAdded.push(entry);
    }
  }
  for (const r of removes) {
    const k = entryKey(r);
    if (!keys.has(k)) {
      skippedRemoves.push(r);
    } else {
      actuallyRemoved.push(keys.get(k));
      keys.delete(k);
    }
  }

  const merged = [...keys.values()].sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
  return {
    next: { version: SUPPORTED_VERSION, entries: merged },
    actuallyAdded,
    actuallyRemoved,
    skippedAdds,
    skippedRemoves,
  };
}

/**
 * Compose the human-readable diff summary emitted to stdout.
 */
export function formatDiffSummary(plan) {
  const lines = [];
  lines.push(`Added (${plan.actuallyAdded.length}):`);
  for (const e of plan.actuallyAdded) {
    lines.push(`  + ${e.file} :: ${e.test}  [reason=${e.reason}]`);
  }
  lines.push(`Removed (${plan.actuallyRemoved.length}):`);
  for (const e of plan.actuallyRemoved) {
    lines.push(`  - ${e.file} :: ${e.test}`);
  }
  if (plan.skippedAdds.length > 0) {
    lines.push(`Skipped adds (already present) (${plan.skippedAdds.length}):`);
    for (const e of plan.skippedAdds) {
      lines.push(`  . ${e.file} :: ${e.test}`);
    }
  }
  if (plan.skippedRemoves.length > 0) {
    lines.push(`Skipped removes (not in baseline) (${plan.skippedRemoves.length}):`);
    for (const e of plan.skippedRemoves) {
      lines.push(`  . ${e.file} :: ${e.test}`);
    }
  }
  return lines.join('\n') + '\n';
}

// =============================================================================
// Main
// =============================================================================

export function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`[baseline-update] ERROR: ${err.message}\n`);
    printHelp(stderr);
    return 3;
  }

  if (args.help) {
    printHelp(stdout);
    return 0;
  }

  const baselinePath = args.baselinePath || defaultBaselinePath();
  if (!existsSync(baselinePath)) {
    stderr.write(
      `[baseline-update] ERROR: baseline file ${baselinePath} not found; ` +
        `bootstrap first via test-baseline-check.mjs --bootstrap\n`,
    );
    return 3;
  }

  // Fail-closed load (corrupt / unknown version / schema violation).
  let baseline;
  try {
    baseline = loadBaselineFile(baselinePath);
  } catch (err) {
    if (err instanceof TestBaselineError) {
      stderr.write(`[baseline-update] ERROR: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (baseline === null) {
    // existsSync true but loader returned null — should be impossible, treat
    // as fail-closed so the operator investigates.
    stderr.write(
      `[baseline-update] ERROR: baseline loader returned null for existing file ${baselinePath}\n`,
    );
    return 2;
  }

  // Plan the update
  const plan = planUpdate(baseline, args.adds, args.removes, args.reason);

  // Always emit the summary so the operator sees what would happen.
  stdout.write(formatDiffSummary(plan));

  const hasOps = plan.actuallyAdded.length > 0 || plan.actuallyRemoved.length > 0;

  // --remove pointing at a non-existent entry is an operator error: exit
  // non-zero with a clear message naming the missing tuples.
  if (plan.skippedRemoves.length > 0 && plan.actuallyRemoved.length === 0 && args.removes.length > 0) {
    const names = plan.skippedRemoves.map((r) => `${r.file} :: ${r.test}`).join(', ');
    stderr.write(
      `[baseline-update] ERROR: --remove target(s) not found in baseline: ${names}\n`,
    );
    return 3;
  }

  // AC1.2: Baseline does NOT auto-update. Require --confirm for writes.
  if (!args.confirm) {
    if (hasOps) {
      stderr.write(
        `[baseline-update] dry-run complete — re-run with --confirm to apply ${plan.actuallyAdded.length} add(s) and ${plan.actuallyRemoved.length} remove(s).\n`,
      );
      return 1;
    }
    // No-op dry-run: exit 0 so scripts can safely call without --confirm
    // to validate that nothing changes.
    stdout.write('[baseline-update] no-op (nothing to change).\n');
    return 0;
  }

  if (!hasOps) {
    stdout.write('[baseline-update] --confirm with no-op; baseline unchanged.\n');
    return 0;
  }

  // AC1.3: Atomic write via tmp + rename.
  const content = JSON.stringify(plan.next, null, 2) + '\n';
  const ok = atomicWriteSentinel(baselinePath, content);
  if (!ok) {
    stderr.write(`[baseline-update] ERROR: atomic write failed for ${baselinePath}\n`);
    return 4;
  }

  stdout.write(
    `[baseline-update] wrote ${plan.next.entries.length} entries to ${baselinePath}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
