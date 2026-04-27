#!/usr/bin/env node

/**
 * verify-enforcement-audit-chain.mjs
 *
 * Hash-chain verifier for `.claude/audit/enforcement-changes.log` (JSONL).
 *
 * Structurally mirrors verify-deployment-audit-chain.mjs. Uses shared
 * RFC-8785 JCS canonicalization via ./lib/jcs-canonicalize.mjs — writers AND
 * verifier MUST produce identical canonicalization so tampering is detectable
 * (NFR-10, security-tagged).
 *
 * Entry kinds (SilentDropAuditLogEntry discriminated union):
 *   - normal: prev_hash = SHA-256 JCS hex of prior entry; genesis has null.
 *   - quarantine: prev_hash = null, last_valid_prev_hash = identity anchor
 *                 (chain-break marker).
 *   - re-genesis: prev_hash = null, quarantine_ref = UUID of preceding
 *                 quarantine entry; restarts the chain post-break.
 *
 * Baseline rejection (AC-16.6): when invoked against a baseline JSON file
 * (not JSONL — a single JSON object with `reengagement_history[]`), the
 * verifier validates reengagement entries against the Zod schema and rejects
 * malformed baselines. This is the publication-time integration check —
 * separate from the primary chain-verification pathway.
 *
 * --- Security boundary documentation (sec-auth-3f1a9c2e, sec-crypto-8b2d4f1c) ---
 *
 * The `signature` field on SilentDropAuditLogEntry is a free-form bearer
 * string; cryptographic identity is enforced at the substrate layer
 * (git-signed commits per NFR-11) and verifier identity match (NFR-12),
 * NOT within this verifier. Schema-level signature verification would
 * duplicate the substrate check.
 *
 * JCS canonicalization via `lib/jcs-canonicalize.mjs` is a RFC-8785 subset
 * (no float normalization, no Unicode NFC). Safe when writer and verifier
 * share this implementation. If a non-JS audit-log writer is introduced,
 * hardening is required before cross-implementation operation.
 *
 * Usage:
 *   node verify-enforcement-audit-chain.mjs [<path>]
 *   node verify-enforcement-audit-chain.mjs --path <path>
 *   node verify-enforcement-audit-chain.mjs --baseline <path>  # force baseline mode
 *
 * Exit codes:
 *   0 - Chain valid end-to-end (or empty log). Baseline valid.
 *   1 - Chain broken (with structured stderr naming the broken-link index)
 *       OR baseline schema invalid.
 *   2 - Log file missing or unreadable.
 *
 * Implements: AC-16.1, AC-16.2, AC-16.3, AC-16.4, AC-16.5, AC-16.6, NFR-10.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { jcsCanonicalize } from './lib/jcs-canonicalize.mjs';
import {
  silentDropAuditLogEntrySchema,
  silentDropBaselineReportSchema,
  reengagementHistoryEntrySchema,
} from './lib/silent-drop-schemas.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Default audit log path relative to cwd. */
const DEFAULT_LOG_PATH = join(
  process.cwd(),
  '.claude',
  'audit',
  'enforcement-changes.log',
);

const EXIT_OK = 0;
const EXIT_CHAIN_BROKEN = 1;
const EXIT_MISSING_OR_UNREADABLE = 2;

// =============================================================================
// Hash helpers
// =============================================================================

/**
 * Compute SHA-256 hex digest of the RFC-8785 JCS canonical form of an entry.
 * @param {object} entry
 * @returns {string} 64-char lowercase hex SHA-256
 */
function hashEntry(entry) {
  return createHash('sha256').update(jcsCanonicalize(entry)).digest('hex');
}

// =============================================================================
// Input-mode detection
// =============================================================================

/**
 * Detect whether the file is a baseline JSON object or a JSONL chain log.
 *
 * Heuristic: if the first non-whitespace character is `{` AND the content
 * parses as a single JSON object with a `reengagement_history` field, treat
 * as baseline. Otherwise treat as JSONL chain.
 *
 * @param {string} content
 * @returns {'baseline' | 'chain'}
 */
function detectMode(content) {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{')) return 'chain';
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && 'reengagement_history' in parsed) {
      return 'baseline';
    }
  } catch {
    // Fall through to chain mode.
  }
  return 'chain';
}

// =============================================================================
// Baseline validation (AC-16.6)
// =============================================================================

/**
 * Validate a baseline JSON file against the baseline schema. Specifically
 * checks the reengagement_history[] entries — malformed history is rejected.
 *
 * @param {string} content - Raw baseline JSON content
 * @returns {{ valid: boolean, error?: string }}
 */
function validateBaseline(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      valid: false,
      error: `baseline JSON invalid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // First attempt full baseline schema. If it fails, attempt the per-entry
  // reengagement validation as a narrower diagnostic (AC-16.6 specifically
  // names reengagement_history).
  const fullResult = silentDropBaselineReportSchema.safeParse(parsed);
  if (fullResult.success) {
    return { valid: true };
  }

  // Narrow check: iterate reengagement entries explicitly.
  const history = Array.isArray(parsed.reengagement_history)
    ? parsed.reengagement_history
    : [];
  for (let i = 0; i < history.length; i++) {
    const entryResult = reengagementHistoryEntrySchema.safeParse(history[i]);
    if (!entryResult.success) {
      const firstIssue = entryResult.error.issues[0];
      return {
        valid: false,
        error: `baseline reengagement_history[${i}].${firstIssue.path.join('.')}: ${firstIssue.message}`,
      };
    }
  }

  // Fell through: other baseline field invalid.
  const firstIssue = fullResult.error.issues[0];
  return {
    valid: false,
    error: `baseline.${firstIssue.path.join('.')}: ${firstIssue.message}`,
  };
}

// =============================================================================
// Chain verification
// =============================================================================

/**
 * Verify the hash chain of an enforcement-changes audit log.
 *
 * Per AC-16.5, quarantine entries (prev_hash=null) and re-genesis entries
 * (prev_hash=null, quarantine_ref set) restart the chain. Between a quarantine
 * and re-genesis we do NOT require prev_hash linkage — the quarantine itself
 * IS the break marker.
 *
 * @param {string} content - Raw JSONL content
 * @returns {{ valid: boolean, brokenIndex?: number, error?: string, entryCount?: number }}
 */
function verifyChain(content) {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { valid: true, entryCount: 0 };
  }

  // prevHash tracks the canonical hash of the preceding entry when chain
  // linkage is expected. After a quarantine/re-genesis pair, linkage resets.
  let prevHash = null;
  let chainRestarted = true; // Treat the first entry as post-restart

  for (let i = 0; i < lines.length; i++) {
    let rawEntry;
    try {
      rawEntry = JSON.parse(lines[i]);
    } catch {
      return {
        valid: false,
        brokenIndex: i,
        error: `entry ${i}: invalid JSON`,
      };
    }

    // Schema-level structural validation.
    const schemaResult = silentDropAuditLogEntrySchema.safeParse(rawEntry);
    if (!schemaResult.success) {
      const firstIssue = schemaResult.error.issues[0];
      return {
        valid: false,
        brokenIndex: i,
        error: `entry ${i} schema invalid at ${firstIssue.path.join('.')}: ${firstIssue.message}`,
      };
    }
    const entry = schemaResult.data;

    // Chain-linkage rules by entry_kind.
    if (entry.entry_kind === 'normal') {
      if (chainRestarted) {
        // Post-restart (or genesis) normal: prev_hash MUST be null.
        if (entry.prev_hash !== null) {
          return {
            valid: false,
            brokenIndex: i,
            error: `entry ${i}: post-restart/genesis normal entry must have prev_hash=null`,
          };
        }
        chainRestarted = false;
      } else {
        // Linked normal: prev_hash MUST match preceding entry hash.
        if (entry.prev_hash !== prevHash) {
          return {
            valid: false,
            brokenIndex: i,
            error: `entry ${i}: prev_hash mismatch (expected ${prevHash}, got ${entry.prev_hash})`,
          };
        }
      }
    } else if (entry.entry_kind === 'quarantine') {
      // Quarantine entries mark a detected chain break. prev_hash is null by
      // schema; the chain is considered restarted from the next entry.
      chainRestarted = true;
    } else if (entry.entry_kind === 're-genesis') {
      // Re-genesis resets the chain. Subsequent normal entry must have
      // prev_hash=hash(re-genesis-entry) for linkage resumption.
      chainRestarted = false;
    }

    prevHash = hashEntry(entry);
  }

  return { valid: true, entryCount: lines.length };
}

// =============================================================================
// CLI entry point
// =============================================================================

function parseArgs(argv) {
  let logPath = DEFAULT_LOG_PATH;
  let forceBaseline = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--path' && i + 1 < argv.length) {
      logPath = argv[++i];
    } else if (arg === '--baseline' && i + 1 < argv.length) {
      logPath = argv[++i];
      forceBaseline = true;
    } else if (!arg.startsWith('--')) {
      logPath = arg;
    }
  }
  return { logPath, forceBaseline };
}

function main() {
  const { logPath, forceBaseline } = parseArgs(process.argv.slice(2));

  if (!existsSync(logPath)) {
    process.stderr.write(
      JSON.stringify({
        event: 'audit_chain_verification_failed',
        result: 'FAIL',
        timestamp: new Date().toISOString(),
        error: `log file missing or unreadable: ${logPath}`,
        log_path: logPath,
      }) + '\n',
    );
    process.exit(EXIT_MISSING_OR_UNREADABLE);
  }

  let content;
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        event: 'audit_chain_verification_failed',
        result: 'FAIL',
        timestamp: new Date().toISOString(),
        error: `log file unreadable: ${err instanceof Error ? err.message : String(err)}`,
        log_path: logPath,
      }) + '\n',
    );
    process.exit(EXIT_MISSING_OR_UNREADABLE);
  }

  const mode = forceBaseline ? 'baseline' : detectMode(content);

  if (mode === 'baseline') {
    const result = validateBaseline(content);
    if (result.valid) {
      process.stderr.write(
        JSON.stringify({
          event: 'baseline_validated',
          result: 'PASS',
          timestamp: new Date().toISOString(),
          log_path: logPath,
        }) + '\n',
      );
      process.exit(EXIT_OK);
    }
    process.stderr.write(
      JSON.stringify({
        event: 'baseline_validation_failed',
        result: 'FAIL',
        timestamp: new Date().toISOString(),
        error: result.error,
        log_path: logPath,
      }) + '\n',
    );
    process.exit(EXIT_CHAIN_BROKEN);
  }

  const result = verifyChain(content);
  if (result.valid) {
    process.stderr.write(
      JSON.stringify({
        event: 'audit_chain_verified',
        result: 'PASS',
        timestamp: new Date().toISOString(),
        entry_count: result.entryCount,
        log_path: logPath,
      }) + '\n',
    );
    process.exit(EXIT_OK);
  }

  process.stderr.write(
    JSON.stringify({
      event: 'audit_chain_verification_failed',
      result: 'FAIL',
      timestamp: new Date().toISOString(),
      broken_index: result.brokenIndex ?? null,
      error: result.error,
      log_path: logPath,
    }) + '\n',
  );
  process.exit(EXIT_CHAIN_BROKEN);
}

main();
