#!/usr/bin/env node

/**
 * Runtime-connectivity enforcement hash-chain verifier.
 *
 * Owner doc: .claude/docs/RTC-ENFORCEMENT-AUDIT.md
 *       (VerificationResult data-model)
 * Requirements: REQ-NFR-025 (tamper resistance, verification HARD-FAIL).
 *
 * Basename note (2026-04-20, inv-crit-5b9a2f14): landed basename is
 * `verify-rtc-enforcement-chain.mjs` — distinct from silent-drop's
 * `verify-enforcement-audit-chain.mjs` to avoid the PROTECTED_FILENAMES
 * collision documented in workflow-file-protection.mjs:238.
 *
 * Public API:
 *   verifyChain(logPath) => VerificationResult
 *
 * VerificationResult:
 *   { status: 'clean' | 'broken' | 'missing',
 *     entry_count: number,
 *     break_at_entry?: number,
 *     observed_hash?: string,
 *     expected_hash?: string }
 *
 * CLI usage:
 *   node verify-rtc-enforcement-chain.mjs <logPath>
 *
 * CLI exit codes (AC5.9):
 *   0 — clean
 *   1 — broken
 *   2 — missing
 *
 * Walker semantics (AC5.1–AC5.7):
 *   - Missing file              → {status: 'missing', entry_count: 0}
 *   - Empty file                → {status: 'clean', entry_count: 0}
 *   - Genesis expected prev_hash = SHA-256("")
 *   - For each entry i:
 *       observed = entry.prev_hash
 *       if observed !== expected → broken at i with that observed/expected pair
 *       else                     → expected = SHA-256(JCS(entry minus prev_hash))
 *   - JSON.parse failure        → broken at that index, observed = "<parse-error>"
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { canonicalizeExcludingField } from './lib/jcs-canonicalize.mjs';

/** SHA-256("") — genesis expected prev_hash. */
const GENESIS_PREV_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const STATUS_CLEAN = 'clean';
const STATUS_BROKEN = 'broken';
const STATUS_MISSING = 'missing';

/**
 * Verify the hash-chain integrity of an enforcement audit log.
 *
 * @param {string} logPath
 * @returns {{status: 'clean' | 'broken' | 'missing',
 *            entry_count: number,
 *            break_at_entry?: number,
 *            observed_hash?: string,
 *            expected_hash?: string}}
 */
export function verifyChain(logPath) {
  if (!existsSync(logPath)) {
    return { status: STATUS_MISSING, entry_count: 0 };
  }

  const raw = readFileSync(logPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { status: STATUS_CLEAN, entry_count: 0 };
  }

  let expectedPrev = GENESIS_PREV_HASH;

  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return {
        status: STATUS_BROKEN,
        entry_count: i,
        break_at_entry: i,
        observed_hash: '<parse-error>',
        expected_hash: expectedPrev,
      };
    }

    const observed = typeof entry.prev_hash === 'string' ? entry.prev_hash : '<missing>';
    if (observed !== expectedPrev) {
      return {
        status: STATUS_BROKEN,
        entry_count: i,
        break_at_entry: i,
        observed_hash: observed,
        expected_hash: expectedPrev,
      };
    }

    // Advance expected for next iteration: hash of THIS entry body minus
    // its own prev_hash.
    const canonical = canonicalizeExcludingField(entry, 'prev_hash');
    expectedPrev = createHash('sha256').update(canonical).digest('hex');
  }

  return { status: STATUS_CLEAN, entry_count: lines.length };
}

// =============================================================================
// CLI entry point
// =============================================================================

function runCli() {
  const argv = process.argv.slice(2);
  const logPath = argv[0];
  if (!logPath) {
    process.stderr.write(
      'usage: verify-rtc-enforcement-chain.mjs <logPath>\n',
    );
    process.exit(2);
    return;
  }
  const result = verifyChain(logPath);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === STATUS_CLEAN) process.exit(0);
  if (result.status === STATUS_BROKEN) process.exit(1);
  process.exit(2);
}

// Detect direct CLI invocation (`node verify-rtc-enforcement-chain.mjs ...`).
// process.argv[1] is the absolute path to this script when invoked as a CLI;
// compare against import.meta.url (file://) via fileURLToPath.
try {
  const selfPath = fileURLToPath(import.meta.url);
  if (process.argv[1] && resolve(process.argv[1]) === selfPath) {
    runCli();
  }
} catch {
  // import.meta.url not a file URL — module loaded via other means; skip CLI.
}
