#!/usr/bin/env node

/**
 * Self-resolution audit trail shared library and CLI tool.
 *
 * Provides:
 * - writeAuditEntry(): Shared function for writing validated audit entries
 * - readAuditTrail(): Read and parse the audit trail
 * - checkCircuitBreaker(): Evaluate per-agent circuit breaker state
 *
 * CLI usage:
 *   node self-resolution-audit.mjs re-enable <agent-name> --rationale "<rationale>"
 *
 * Spec: sg-self-answering-agents
 * ACs: AC-7.1 through AC-7.9, AC-9.1 through AC-9.5
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Constants
// =============================================================================

const AUDIT_FILENAME = 'self-resolutions.jsonl';
const LOCK_FILENAME = 'self-resolutions.lock';

/** Valid entry types. */
const VALID_TYPES = [
  'resolution',
  'override',
  'circuit_breaker_activated',
  'circuit_breaker_re_enabled',
];

/** Circuit breaker window size (number of entries to consider). */
const CIRCUIT_BREAKER_WINDOW_SIZE = 20;

/** Circuit breaker threshold (override rate must EXCEED this to activate). */
const CIRCUIT_BREAKER_THRESHOLD = 0.10;

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate an audit entry against the schema.
 *
 * @param {object} entry - The entry to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEntry(entry) {
  const errors = [];

  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be a non-null object'] };
  }

  // Common required fields
  if (typeof entry.agent !== 'string' || entry.agent.trim().length === 0) {
    errors.push('agent must be a non-empty string');
  }

  if (!VALID_TYPES.includes(entry.type)) {
    errors.push(
      `type must be one of: ${VALID_TYPES.join(', ')}; got "${entry.type}"`
    );
  }

  // Type-specific validation
  if (entry.type === 'resolution') {
    if (
      typeof entry.tier !== 'number' ||
      !Number.isInteger(entry.tier) ||
      entry.tier < 1 ||
      entry.tier > 4
    ) {
      errors.push('tier must be an integer 1-4 for resolution entries');
    }

    if (typeof entry.question !== 'string' || entry.question.trim().length === 0) {
      errors.push('question must be a non-empty string for resolution entries');
    }

    if (typeof entry.resolution !== 'string' || entry.resolution.trim().length === 0) {
      errors.push('resolution must be a non-empty string for resolution entries');
    }

    // Tier 1-2 require evidence
    if (entry.tier >= 1 && entry.tier <= 2) {
      if (
        typeof entry.evidence_snippet !== 'string' ||
        entry.evidence_snippet.trim().length === 0
      ) {
        errors.push('evidence_snippet is required for tier 1-2 resolution entries');
      }
      if (
        typeof entry.source_ref !== 'string' ||
        entry.source_ref.trim().length === 0
      ) {
        errors.push('source_ref is required for tier 1-2 resolution entries');
      }
    }
  }

  if (entry.type === 'override') {
    if (typeof entry.original_entry_id !== 'number') {
      errors.push('original_entry_id must be a number for override entries');
    }
    if (typeof entry.human_correction !== 'string') {
      errors.push('human_correction must be a string for override entries');
    }
  }

  if (entry.type === 'circuit_breaker_activated') {
    if (typeof entry.override_rate !== 'number') {
      errors.push('override_rate must be a number for circuit_breaker_activated entries');
    }
    if (typeof entry.window_size !== 'number') {
      errors.push('window_size must be a number for circuit_breaker_activated entries');
    }
  }

  if (entry.type === 'circuit_breaker_re_enabled') {
    if (typeof entry.rationale !== 'string') {
      errors.push('rationale must be a string for circuit_breaker_re_enabled entries');
    }
    if (typeof entry.re_enabled_by !== 'string') {
      errors.push('re_enabled_by must be a string for circuit_breaker_re_enabled entries');
    }
  }

  return { valid: errors.length === 0, errors };
}

// =============================================================================
// File I/O with Advisory Locking
// =============================================================================

/**
 * Acquire an advisory lock file. Busy-waits with exponential backoff.
 *
 * @param {string} lockPath - Path to lock file
 * @param {number} [maxWaitMs=5000] - Maximum time to wait
 * @returns {boolean} Whether lock was acquired
 */
function acquireLock(lockPath, maxWaitMs = 5000) {
  const start = Date.now();
  let delay = 1;

  while (Date.now() - start < maxWaitMs) {
    try {
      // O_EXCL equivalent: writeFileSync with flag 'wx' fails if file exists
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      // Lock held by another process; busy-wait
      const waitUntil = Date.now() + delay;
      while (Date.now() < waitUntil) {
        // Spin
      }
      delay = Math.min(delay * 2, 50);
    }
  }
  return false;
}

function releaseLockSync(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // Best-effort
  }
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Read and parse the audit trail file.
 *
 * @param {object} [options]
 * @param {string} [options.auditDir] - Directory containing the audit file
 * @returns {Array<object>} Parsed entries
 */
export function readAuditTrail({ auditDir } = {}) {
  const dir = auditDir || join(process.cwd(), '.claude', 'audit');
  const filePath = join(dir, AUDIT_FILENAME);

  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const entries = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/**
 * Write a validated audit entry to the JSONL audit trail.
 *
 * Features:
 * - Schema validation (AC-7.4)
 * - Sequential entry_id assignment (AC-7.2)
 * - Append-only semantics (AC-7.3)
 * - Advisory lock for concurrent writes (AC-7.5)
 * - Partial last line recovery (AC-7.6)
 * - Entry ID gap preservation (AC-7.7)
 *
 * @param {object} entry - The audit entry (without entry_id and timestamp)
 * @param {object} [options]
 * @param {string} [options.auditDir] - Directory containing the audit file
 * @returns {object} The written entry with entry_id and timestamp
 */
export function writeAuditEntry(entry, { auditDir } = {}) {
  // Validate schema (AC-7.4)
  const validation = validateEntry(entry);
  if (!validation.valid) {
    throw new Error(
      `Audit entry validation failed: ${validation.errors.join('; ')}`
    );
  }

  const dir = auditDir || join(process.cwd(), '.claude', 'audit');
  const filePath = join(dir, AUDIT_FILENAME);
  const lockPath = join(dir, LOCK_FILENAME);

  // Ensure directory exists
  mkdirSync(dir, { recursive: true });

  // Acquire advisory lock (AC-7.5)
  const locked = acquireLock(lockPath);
  if (!locked) {
    throw new Error('Failed to acquire audit trail lock');
  }

  try {
    // Read existing entries to determine next entry_id
    let existingContent = '';
    let highestId = 0;
    let needsCorruptionRecovery = false;

    if (existsSync(filePath)) {
      existingContent = readFileSync(filePath, 'utf-8');
      const lines = existingContent.split('\n');

      // Check for partial last line (AC-7.6)
      const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
      const validLines = [];
      let previousId = 0;

      for (const line of nonEmptyLines) {
        try {
          const parsed = JSON.parse(line);
          validLines.push(line);
          if (parsed.entry_id > highestId) {
            highestId = parsed.entry_id;
          }

          // Check for ID gaps (AC-7.7)
          if (previousId > 0 && parsed.entry_id > previousId + 1) {
            console.warn(
              `[self-resolution-audit] Entry ID gap detected: ${previousId} -> ${parsed.entry_id}`
            );
          }
          previousId = parsed.entry_id;
        } catch {
          // Partial/corrupt line detected (AC-7.6)
          needsCorruptionRecovery = true;
          console.warn(
            '[self-resolution-audit] Corrupt line detected and removed during recovery'
          );
        }
      }

      if (needsCorruptionRecovery) {
        // Rewrite file with only valid lines
        existingContent = validLines.join('\n') + (validLines.length > 0 ? '\n' : '');
        writeFileSync(filePath, existingContent);
      }
    }

    // Assign entry_id and timestamp (AC-7.2)
    // Auto-assigned fields come LAST so callers cannot override them
    const newEntry = {
      ...entry,
      entry_id: highestId + 1,
      timestamp: new Date().toISOString(),
    };

    // Append to file (AC-7.3)
    // Reuse existingContent from first read to avoid a second file read under lock
    const newLine = JSON.stringify(newEntry) + '\n';
    if (existingContent.length > 0 && !existingContent.endsWith('\n')) {
      writeFileSync(filePath, existingContent + '\n' + newLine);
    } else {
      writeFileSync(filePath, existingContent + newLine);
    }

    return newEntry;
  } finally {
    // Release lock
    releaseLockSync(lockPath);
  }
}

// =============================================================================
// Circuit Breaker
// =============================================================================

/**
 * Check circuit breaker status for a specific agent.
 *
 * Evaluates the last CIRCUIT_BREAKER_WINDOW_SIZE entries for the agent.
 * If override rate exceeds CIRCUIT_BREAKER_THRESHOLD, the breaker activates.
 *
 * Also checks for circuit_breaker_activated and circuit_breaker_re_enabled entries:
 * - If the most recent is circuit_breaker_re_enabled, breaker is deactivated
 * - If the most recent is circuit_breaker_activated, check if re-enabled since
 *
 * @param {string} agentName - The agent name to check
 * @param {object} [options]
 * @param {string} [options.auditDir] - Directory containing the audit file
 * @returns {{ active: boolean, overrideRate?: number, windowSize?: number }}
 */
export function checkCircuitBreaker(agentName, { auditDir } = {}) {
  const entries = readAuditTrail({ auditDir });

  // Filter entries for this agent
  const agentEntries = entries.filter((e) => e.agent === agentName);

  if (agentEntries.length === 0) {
    return { active: false };
  }

  // Check for explicit circuit breaker state entries
  const breakerEntries = agentEntries.filter(
    (e) =>
      e.type === 'circuit_breaker_activated' ||
      e.type === 'circuit_breaker_re_enabled'
  );

  // If there are breaker entries, check the most recent one
  if (breakerEntries.length > 0) {
    const lastBreakerEntry = breakerEntries[breakerEntries.length - 1];
    if (lastBreakerEntry.type === 'circuit_breaker_re_enabled') {
      return { active: false };
    }
    // If last breaker entry is activated, it's still active
    // (unless override rate has dropped, which would require re-evaluation)
    // For simplicity and per spec: activated stays active until re-enabled
    if (lastBreakerEntry.type === 'circuit_breaker_activated') {
      return { active: true, overrideRate: lastBreakerEntry.override_rate };
    }
  }

  // Calculate override rate from resolution and override entries
  const resolutionEntries = agentEntries.filter((e) => e.type === 'resolution');
  const overrideEntries = agentEntries.filter((e) => e.type === 'override');

  // Use the last WINDOW_SIZE entries (resolutions + overrides)
  const windowEntries = [...resolutionEntries, ...overrideEntries]
    .sort((a, b) => a.entry_id - b.entry_id)
    .slice(-CIRCUIT_BREAKER_WINDOW_SIZE);

  const windowOverrides = windowEntries.filter((e) => e.type === 'override').length;
  const windowTotal = windowEntries.length;

  if (windowTotal === 0) {
    return { active: false };
  }

  const overrideRate = windowOverrides / windowTotal;

  // Activate if override rate EXCEEDS threshold (not equal to)
  if (overrideRate > CIRCUIT_BREAKER_THRESHOLD) {
    return {
      active: true,
      overrideRate,
      windowSize: windowTotal,
    };
  }

  return { active: false, overrideRate, windowSize: windowTotal };
}

// =============================================================================
// CLI Entry Point (guarded: only runs when script is invoked directly)
// =============================================================================

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 're-enable') {
    const agentName = args[1];
    const rationaleIdx = args.indexOf('--rationale');
    const rationale =
      rationaleIdx >= 0 ? args[rationaleIdx + 1] : 'Manual re-enable';

    if (!agentName) {
      console.error('Usage: self-resolution-audit.mjs re-enable <agent-name> --rationale "<rationale>"');
      process.exit(1);
    }

    const auditDir =
      process.env.AUDIT_DIR || join(process.cwd(), '.claude', 'audit');

    try {
      const entry = writeAuditEntry(
        {
          agent: agentName,
          type: 'circuit_breaker_re_enabled',
          rationale,
          re_enabled_by: 'human',
        },
        { auditDir }
      );
      console.log(
        `Circuit breaker re-enabled for ${agentName} (entry_id: ${entry.entry_id})`
      );
      process.exit(0);
    } catch (err) {
      console.error(`Failed to re-enable circuit breaker: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.error('Usage: self-resolution-audit.mjs re-enable <agent-name> --rationale "<rationale>"');
    process.exit(1);
  }
}
