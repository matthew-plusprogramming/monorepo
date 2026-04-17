/**
 * Deployment Intervention Audit Log Writer
 *
 * Appends hash-chained entries to .claude/audit/deployment-interventions.log
 * following the AuditLogEntry contract (silent-drop-observability REQ-NFR-010).
 *
 * Each entry is canonicalized via RFC 8785 JCS before hashing for chain integrity.
 * Genesis entry has prev_hash: null. Subsequent entries chain to prior.
 *
 * Implements: AC-14.7, AC-14.8
 * Spec: sg-deployment-verification-gaps
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { jcsCanonicalize } from './jcs-canonicalize.mjs';
import { findClaudeDir } from './hook-utils.mjs';
import { acquireLock, releaseLock } from './session-lock.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Default audit log path. */
function getAuditLogPath() {
  return join(findClaudeDir(import.meta.url), 'audit', 'deployment-interventions.log');
}

// =============================================================================
// Audit Log Writer
// =============================================================================

/**
 * Read the last entry from the audit log to compute prev_hash.
 *
 * @param {string} logPath - Absolute path to JSONL log file
 * @returns {{ lastEntry: object|null, prevHash: string|null }}
 */
function readLastEntry(logPath) {
  if (!existsSync(logPath)) {
    return { lastEntry: null, prevHash: null };
  }

  let content;
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch {
    return { lastEntry: null, prevHash: null };
  }

  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { lastEntry: null, prevHash: null };
  }

  try {
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    const canonical = jcsCanonicalize(lastEntry);
    const prevHash = createHash('sha256').update(canonical).digest('hex');
    return { lastEntry, prevHash };
  } catch {
    return { lastEntry: null, prevHash: null };
  }
}

/**
 * Append a hash-chained entry to the deployment intervention audit log.
 *
 * @param {object} params - Entry parameters
 * @param {string} params.operator - Identity of the actor
 * @param {string} params.correlation_id - Links to deploy session
 * @param {object} params.payload - Deployment-specific payload (kind, service, hashes, etc.)
 * @param {string} [params.entry_kind='normal'] - Envelope kind
 * @param {string} [params.signature='unsigned'] - Signature placeholder
 * @param {string} [params.logPath] - Override log path for testing
 */
export async function appendAuditLogEntry(params) {
  const logPath = params.logPath || getAuditLogPath();

  // Ensure directory exists
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // H1/F-2 fix: Acquire file lock around read-last + append to prevent
  // TOCTOU race where concurrent callers fork the hash chain.
  const lockPath = logPath + '.lock';
  const lockAcquired = acquireLock(lockPath, { failOpen: false });

  try {
    // Read last entry for chain hash (inside lock)
    const { prevHash } = readLastEntry(logPath);

    // Build AuditLogEntry per contract
    const entry = {
      entry_id: randomUUID(),
      prev_hash: prevHash, // null for genesis, SHA-256 of prior for subsequent
      timestamp: new Date().toISOString(),
      operator: params.operator,
      signature: params.signature || 'unsigned',
      correlation_id: params.correlation_id,
      entry_kind: params.entry_kind || 'normal',
      payload: params.payload,
    };

    // Append as JSON Line (inside lock)
    appendFileSync(logPath, JSON.stringify(entry) + '\n');

    return entry;
  } finally {
    releaseLock(lockPath);
  }
}
