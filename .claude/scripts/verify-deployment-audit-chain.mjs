#!/usr/bin/env node

/**
 * Deployment Intervention Audit Chain Verifier
 *
 * Reads .claude/audit/deployment-interventions.log (JSON Lines format),
 * verifies the hash chain end-to-end using RFC 8785 JCS canonicalization.
 *
 * Pattern: silent-drop-observability REQ-NFR-010 hash-chain audit log.
 * Canonical source: .claude/memory-bank/org-context.md Architectural Conventions.
 *
 * Exit codes:
 *   0 - Chain valid end-to-end (or empty log)
 *   1 - Chain broken at index <n> (structured stderr)
 *   2 - Log file missing or unreadable
 *
 * Usage:
 *   node verify-deployment-audit-chain.mjs [--path <log-path>]
 *
 * Implements: AC-14.7
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { jcsCanonicalize } from './lib/jcs-canonicalize.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Default audit log path relative to .claude/ */
const DEFAULT_LOG_PATH = join(process.cwd(), '.claude', 'audit', 'deployment-interventions.log');

// =============================================================================
// Chain Verification
// =============================================================================

/**
 * Compute SHA-256 hash of an entry's JCS canonical form.
 *
 * @param {object} entry - Audit log entry
 * @returns {string} 64-char lowercase hex SHA-256 hash
 */
function hashEntry(entry) {
  const canonical = jcsCanonicalize(entry);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Verify the hash chain of a deployment intervention audit log.
 *
 * @param {string} logPath - Absolute path to the JSONL log file
 * @returns {{ valid: boolean, brokenIndex?: number, error?: string }}
 */
function verifyChain(logPath) {
  // Check file exists
  if (!existsSync(logPath)) {
    return { valid: false, error: 'Log file missing or unreadable', exitCode: 2 };
  }

  let content;
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch (err) {
    return { valid: false, error: `Log file unreadable: ${err.message}`, exitCode: 2 };
  }

  // Split into lines, filter empty
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  // Empty log is valid (AC-14.7)
  if (lines.length === 0) {
    return { valid: true, entryCount: 0 };
  }

  let prevHash = null;

  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return {
        valid: false,
        brokenIndex: i,
        error: `Entry ${i}: invalid JSON`,
        exitCode: 1,
      };
    }

    // Verify prev_hash chain
    if (i === 0) {
      // Genesis entry: prev_hash must be null (not empty string)
      if (entry.prev_hash !== null) {
        return {
          valid: false,
          brokenIndex: 0,
          error: 'Genesis entry (index 0) must have prev_hash: null',
          exitCode: 1,
        };
      }
    } else {
      // Subsequent entries: prev_hash must match SHA-256 of prior entry
      if (entry.prev_hash !== prevHash) {
        return {
          valid: false,
          brokenIndex: i,
          error: `Entry ${i}: prev_hash mismatch (expected ${prevHash}, got ${entry.prev_hash})`,
          exitCode: 1,
        };
      }
    }

    // Compute hash of this entry for next iteration
    prevHash = hashEntry(entry);
  }

  return { valid: true, entryCount: lines.length };
}

// =============================================================================
// Main
// =============================================================================

function main() {
  // Parse --path flag
  const args = process.argv.slice(2);
  let logPath = DEFAULT_LOG_PATH;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && i + 1 < args.length) {
      logPath = args[i + 1];
      i++;
    }
  }

  const result = verifyChain(logPath);

  if (result.valid) {
    process.stderr.write(
      JSON.stringify({
        event: 'audit_chain_verified',
        result: 'PASS',
        timestamp: new Date().toISOString(),
        entry_count: result.entryCount,
        log_path: logPath,
      }) + '\n'
    );
    process.exit(0);
  }

  // Output structured error
  process.stderr.write(
    JSON.stringify({
      event: 'audit_chain_verification_failed',
      result: 'FAIL',
      timestamp: new Date().toISOString(),
      broken_index: result.brokenIndex ?? null,
      error: result.error,
      log_path: logPath,
    }) + '\n'
  );

  process.exit(result.exitCode || 1);
}

main();
