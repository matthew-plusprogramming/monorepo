#!/usr/bin/env node

/**
 * validate-minimum-pruning-floor.mjs
 *
 * CLI entry point wiring `validateMinimumPruningFloor` (lib helper) to the
 * filesystem. Invoked by the `/enforce` skill before atomicity-enforcement
 * completes (AC14.4).
 *
 * The CLI is I/O-only: it reads the canonical PerGateThresholdTable from
 * the lib module, optionally reads the decisions file, calls the pure
 * validator, and translates the structured result into an exit code +
 * stderr report.
 *
 * Usage:
 *   node .claude/scripts/validate-minimum-pruning-floor.mjs [--json]
 *   node .claude/scripts/validate-minimum-pruning-floor.mjs --decisions <path>
 *
 * Options:
 *   --json              Emit the structured result as JSON on stdout and
 *                       suppress the human-readable stderr report. Useful
 *                       when the caller (e.g., /enforce orchestration)
 *                       needs machine-readable output.
 *   --decisions <path>  Override the default decisions-file path
 *                       (.claude/prds/pipeline-efficiency/threshold-
 *                       decisions.md). Path is resolved relative to cwd.
 *
 * Exit codes:
 *   0 - Floor satisfied (relaxed gate found OR decisions-file override OK).
 *   1 - MINIMUM_PRUNING_FLOOR_VIOLATION (AC14.1, AC14.3).
 *   2 - Unexpected error (module import failure, unreadable decisions file).
 *
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning / as-014
 *   - AC14.1, AC14.3, AC14.4.
 * Implements: REQ-001 (minimum-pruning floor).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PerGateThresholdTable } from './lib/per-gate-threshold-table.mjs';
import {
  validateMinimumPruningFloor,
  THRESHOLD_DECISIONS_PATH,
  MINIMUM_PRUNING_FLOOR_VIOLATION,
} from './lib/minimum-pruning-floor.mjs';

// =============================================================================
// Constants
// =============================================================================

const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_UNEXPECTED = 2;

// =============================================================================
// Argument parsing
// =============================================================================

/**
 * Parse CLI arguments. Minimal parser -- only the three flags this tool
 * supports. Unknown flags are surfaced as usage errors so typos fail loudly.
 *
 * @param {string[]} argv
 * @returns {{ json: boolean, decisionsPath: string }}
 */
function parseArgs(argv) {
  const out = {
    json: false,
    decisionsPath: THRESHOLD_DECISIONS_PATH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      out.json = true;
    } else if (arg === '--decisions') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--decisions requires a path argument');
      }
      out.decisionsPath = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(EXIT_OK);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: validate-minimum-pruning-floor.mjs [--json] [--decisions <path>]',
      '',
      'Validates BIZ-002 minimum-pruning floor against PerGateThresholdTable.',
      'Exits 0 on pass, 1 on MINIMUM_PRUNING_FLOOR_VIOLATION, 2 on error.',
      '',
    ].join('\n'),
  );
}

// =============================================================================
// Reporters
// =============================================================================

/**
 * Human-readable report for stderr. Kept compact so it fits alongside
 * other /enforce output without scrolling.
 *
 * @param {ReturnType<typeof validateMinimumPruningFloor>} result
 * @returns {string}
 */
function formatHumanReport(result) {
  if (result.ok) {
    if (result.via === 'relaxed-gate') {
      return (
        `minimum-pruning floor OK: relaxed gate(s) = ` +
        `${(result.relaxed_gates || []).join(', ')}`
      );
    }
    return 'minimum-pruning floor OK: decisions-file override accepted';
  }
  const e = result.error || {};
  const lines = [`${MINIMUM_PRUNING_FLOOR_VIOLATION}: ${e.message || ''}`, ''];
  lines.push('Per-gate summary:');
  for (const row of e.gate_summary || []) {
    lines.push(
      `  - ${row.gate}: required_clean_passes=${row.required_clean_passes}, ` +
        `attestation_mode=${row.attestation_mode}, relaxed=${row.relaxed}`,
    );
  }
  lines.push('');
  const df = e.decisions_file || {};
  lines.push(`Decisions file: ${df.path}`);
  lines.push(`  exists=${df.exists}`);
  lines.push(`  has_biz_002_tag=${df.has_biz_002_tag}`);
  if ((df.missing_gates || []).length > 0) {
    lines.push(`  missing_gates: ${df.missing_gates.join(', ')}`);
  }
  if ((df.unverified_gates || []).length > 0) {
    lines.push(`  unverified_gates: ${df.unverified_gates.join(', ')}`);
  }
  lines.push('');
  lines.push(e.remediation || '');
  return lines.join('\n');
}

// =============================================================================
// Main
// =============================================================================

/**
 * Entry point. Wraps the run in a try/catch so I/O failures surface as
 * EXIT_UNEXPECTED (2) rather than silent non-zero exits.
 *
 * @returns {Promise<number>}
 */
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err?.message || err}\n`);
    printUsage();
    return EXIT_UNEXPECTED;
  }

  const decisionsAbs = resolve(process.cwd(), args.decisionsPath);
  const decisionsFileExists = existsSync(decisionsAbs);
  let decisionsFileContent = '';
  if (decisionsFileExists) {
    try {
      decisionsFileContent = readFileSync(decisionsAbs, 'utf8');
    } catch (err) {
      process.stderr.write(
        `Failed to read decisions file ${decisionsAbs}: ${err?.message || err}\n`,
      );
      return EXIT_UNEXPECTED;
    }
  }

  const result = validateMinimumPruningFloor({
    table: PerGateThresholdTable,
    decisionsFileExists,
    decisionsFileContent,
    decisionsFilePath: args.decisionsPath,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const report = formatHumanReport(result);
    const stream = result.ok ? process.stdout : process.stderr;
    stream.write(`${report}\n`);
  }

  return result.ok ? EXIT_OK : EXIT_VIOLATION;
}

// =============================================================================
// Module guard -- only run main() when invoked as a script.
// =============================================================================

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('validate-minimum-pruning-floor.mjs');

if (isDirectInvocation) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(
        `Unexpected error: ${err?.stack || err?.message || err}\n`,
      );
      process.exit(EXIT_UNEXPECTED);
    });
}

export { main, parseArgs, formatHumanReport };
