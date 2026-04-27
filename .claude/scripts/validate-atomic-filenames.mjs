#!/usr/bin/env node

/**
 * validate-atomic-filenames.mjs — CLI entry point for the /enforce skill.
 *
 * Thin wrapper around `lib/enforce-filename-validator.mjs`. Invoked by the
 * `/enforce` skill before the atomicity-enforcer agent runs; translates the
 * structured validator result into an exit code + stderr/stdout report.
 *
 * The atomicity-enforcer agent itself has read-only tools (Read/Glob/Grep)
 * and cannot execute validation logic — hence this CLI lives as a sibling
 * of `validate-minimum-pruning-floor.mjs` (the precedent pre-step used by
 * the same skill).
 *
 * Spec: sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-013 / REQ-008.
 *
 * Usage:
 *   node .claude/scripts/validate-atomic-filenames.mjs <spec-group-dir>
 *   node .claude/scripts/validate-atomic-filenames.mjs <spec-group-dir> --json
 *
 * Exit codes:
 *   0 — All filenames canonical; IDs unique per workstream (AC13.1, AC13.2
 *       accept case, AC13.3 no duplicates).
 *   1 — ATOMIC_FILENAME_VIOLATION. One or more malformed / duplicate
 *       filenames (AC13.2 malformed case, AC13.3 duplicate case).
 *   2 — Unexpected error (missing directory, unreadable atomic/ subtree,
 *       bad CLI usage).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  validateAtomicFilenames,
  ATOMIC_FILENAME_VIOLATION,
} from './lib/enforce-filename-validator.mjs';

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
 * Parse CLI arguments. Positional: spec-group directory. Flag: --json.
 *
 * @param {string[]} argv
 * @returns {{ specGroupDir: string, json: boolean }}
 */
export function parseArgs(argv) {
  const out = { specGroupDir: '', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      out.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(EXIT_OK);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (!out.specGroupDir) {
      out.specGroupDir = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }
  if (!out.specGroupDir) {
    throw new Error('spec-group-dir is required');
  }
  return out;
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: validate-atomic-filenames.mjs <spec-group-dir> [--json]',
      '',
      'Validates atomic-spec filenames under <spec-group-dir>/atomic/.',
      'Exits 0 on pass, 1 on ATOMIC_FILENAME_VIOLATION, 2 on error.',
      '',
    ].join('\n'),
  );
}

// =============================================================================
// Reporters
// =============================================================================

/**
 * Human-readable report for stderr/stdout. Matches the compact style used
 * by `validate-minimum-pruning-floor.mjs` so `/enforce` output stays
 * uniform across validators.
 *
 * @param {{ errors: object[], warnings: object[] }} result
 * @param {{ specGroupDir: string, fileCount: number }} ctx
 * @returns {string}
 */
export function formatHumanReport(result, ctx) {
  if (result.errors.length === 0) {
    return (
      `atomic-filename validator OK: ${ctx.fileCount} file(s) checked ` +
      `under ${ctx.specGroupDir}/atomic/`
    );
  }
  const lines = [
    `${ATOMIC_FILENAME_VIOLATION}: ${result.errors.length} issue(s) in ` +
      `${ctx.specGroupDir}/atomic/`,
    '',
  ];
  for (const err of result.errors) {
    if (err.reason === 'malformed-filename') {
      lines.push(`  - malformed-filename: ${err.filename}`);
      lines.push(`      expected one of: ${(err.expected || []).join(', ')}`);
    } else if (err.reason === 'duplicate-atomic-id-in-workstream') {
      lines.push(
        `  - duplicate-atomic-id-in-workstream: ` +
          `${err.workstream_id ?? '<unknown-ws>'} / ${err.atomic_id}`,
      );
      for (const fn of err.filenames || []) {
        lines.push(`      ${fn}`);
      }
    } else {
      lines.push(`  - ${err.reason || 'unknown'}: ${err.filename || ''}`);
    }
  }
  lines.push('');
  lines.push(
    'Remediation: rename offending files to one of the three canonical ' +
      'forms (plain, slug, or legacy ws-prefixed) and ensure each ' +
      '(workstream_id, atomic-id) tuple is unique within the spec group.',
  );
  return lines.join('\n');
}

// =============================================================================
// Main
// =============================================================================

/**
 * Entry point. Wraps the run in try/catch so I/O + usage failures surface
 * as EXIT_UNEXPECTED (2) rather than silent non-zero exits.
 *
 * @returns {Promise<number>}
 */
export async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err?.message || err}\n`);
    printUsage();
    return EXIT_UNEXPECTED;
  }

  const specGroupDirAbs = resolve(process.cwd(), args.specGroupDir);
  if (!existsSync(specGroupDirAbs)) {
    process.stderr.write(
      `spec-group directory not found: ${specGroupDirAbs}\n`,
    );
    return EXIT_UNEXPECTED;
  }
  const stat = statSync(specGroupDirAbs);
  if (!stat.isDirectory()) {
    process.stderr.write(
      `spec-group path is not a directory: ${specGroupDirAbs}\n`,
    );
    return EXIT_UNEXPECTED;
  }

  /** @type {{ errors: object[], warnings: object[] }} */
  let result;
  try {
    result = await validateAtomicFilenames(specGroupDirAbs);
  } catch (err) {
    process.stderr.write(`${err?.message || err}\n`);
    return EXIT_UNEXPECTED;
  }

  // File count for the human report — recompute from the FS so the count
  // reflects the full set (malformed + parsed + duplicates), not just the
  // findings array.
  const fileCount = countAtomicMdFiles(specGroupDirAbs);

  const ctx = {
    specGroupDir: specGroupDirAbs,
    fileCount,
  };

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.errors.length === 0,
          spec_group_dir: specGroupDirAbs,
          atomic_files_count: fileCount,
          errors: result.errors,
          warnings: result.warnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const report = formatHumanReport(result, ctx);
    const stream = result.errors.length === 0 ? process.stdout : process.stderr;
    stream.write(`${report}\n`);
  }

  return result.errors.length === 0 ? EXIT_OK : EXIT_VIOLATION;
}

// =============================================================================
// Filesystem helper — count *.md under <sgDir>/atomic/ for the human report.
// =============================================================================

/**
 * @param {string} specGroupDirAbs
 * @returns {number}
 */
function countAtomicMdFiles(specGroupDirAbs) {
  try {
    const atomicDir = resolve(specGroupDirAbs, 'atomic');
    const entries = readdirSync(atomicDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

// =============================================================================
// Module guard
// =============================================================================

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('validate-atomic-filenames.mjs');

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

export { ATOMIC_FILENAME_VIOLATION };
