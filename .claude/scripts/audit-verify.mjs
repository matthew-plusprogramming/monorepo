#!/usr/bin/env node

/**
 * audit-verify.mjs — chain integrity verifier for kill-switch audit log.
 *
 * Kill-switch audit verification contract:
 *   Reads `.claude/audit/kill-switch.log.jsonl`, recomputes the prev_hash chain,
 *   and detects:
 *     - Sequence gaps or duplicates.
 *     - prev_hash mismatches (tampered entries).
 *     - Malformed JSON lines.
 *
 *   Exit codes:
 *     0 — chain intact.
 *     1 — tamper or gap detected.
 *     2 — log absent (not an error; nothing to verify).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getCanonicalProjectDir } from './lib/hook-utils.mjs';
import { canonicalJSON } from './lib/audit-chain.mjs';

const PREV_HASH_ZERO = '0'.repeat(64);

// canonicalJSON is imported from lib/audit-chain.mjs (L1-low consolidation).
// Byte-identical with audit-append.mjs by construction — both pull from the
// same source of truth. See that module for the Merkle-chain contract
// commentary (cr-quality-6d8f029c, sec-crypto-9a2e1506).

function main() {
  let root;
  try {
    root = getCanonicalProjectDir();
  } catch (err) {
    process.stderr.write(JSON.stringify({ error_code: 'E_PROJECT_ROOT', message: err.message }) + '\n');
    process.exit(1);
  }
  const logPath = join(root, '.claude', 'audit', 'kill-switch.log.jsonl');
  if (!existsSync(logPath)) {
    process.stdout.write(JSON.stringify({ status: 'absent', message: 'audit log not present' }) + '\n');
    process.exit(2);
  }

  const lines = readFileSync(logPath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
  let prevHash = PREV_HASH_ZERO;
  let expectedSeq = 1;
  const violations = [];
  for (const [i, line] of lines.entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      violations.push({ index: i, reason: 'malformed-json' });
      continue;
    }
    if (entry.seq !== expectedSeq) {
      violations.push({ index: i, reason: 'seq-gap', expected: expectedSeq, got: entry.seq });
    }
    if (entry.prev_hash !== prevHash) {
      violations.push({ index: i, reason: 'prev-hash-mismatch', expected: prevHash, got: entry.prev_hash });
    }
    prevHash = createHash('sha256').update(canonicalJSON(entry)).digest('hex');
    expectedSeq = entry.seq + 1;
  }

  if (violations.length > 0) {
    process.stderr.write(JSON.stringify({ status: 'tampered', violations }) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ status: 'ok', entries: lines.length }) + '\n');
  process.exit(0);
}

main();
