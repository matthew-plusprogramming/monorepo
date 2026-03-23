#!/usr/bin/env node

/**
 * E2E Black-Box Enforcement PreToolUse Hook
 *
 * Two-hook sentinel pattern for enforcing the black-box guarantee
 * on the e2e-test-writer agent. A single script handles three matchers
 * (Agent, Read, Edit|Write) by inspecting `tool_name` from stdin.
 *
 * Hook 1 (Agent matcher): Intercepts e2e-test-writer dispatch, writes
 * sentinel file `.claude/coordination/active-e2e-session`.
 *
 * Hook 2 (Read matcher): Checks sentinel; if active, enforces read allowlist.
 *
 * Hook 3 (Edit|Write matcher): Checks sentinel; if active, enforces write allowlist.
 *
 * Sentinel lifecycle:
 * - Created: Agent hook intercepts e2e-test-writer dispatch
 * - Active: Read/Write hooks check sentinel on every file operation
 * - Deleted: Agent hook cleanup when e2e-test-writer completes
 * - Stale protection: Sentinel includes session_id; hooks ignore stale sentinels
 *
 * Exit codes:
 *   0 - Allow operation
 *   2 - Block operation (disallowed read/write)
 *
 * Implements: REQ-014, REQ-028
 * Spec: sg-e2e-testing
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// =============================================================================
// Constants
// =============================================================================

/** Sentinel file path relative to project root */
const SENTINEL_RELATIVE_PATH = '.claude/coordination/active-e2e-session';

/** Read allowlist: anchored prefixes resolved against workspace root (AC-14.2) */
const READ_ALLOWLIST_PREFIXES = [
  '.claude/specs/',
  '.claude/contracts/',
  '.claude/templates/',
  'tests/',
  'docs/',
];

/** Write allowlist: anchored prefixes resolved against workspace root (AC-14.3) */
const WRITE_ALLOWLIST_PREFIXES = [
  'tests/e2e/',
];

// =============================================================================
// Helpers
// =============================================================================

/**
 * Read all stdin as a string.
 * @returns {Promise<string>} Raw stdin content
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Find the project root directory by looking for .claude/ directory.
 * @returns {string} Absolute path to project root
 */
function findProjectRoot() {
  // Use CLAUDE_PROJECT_DIR if available
  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  // Fallback: walk up from cwd
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, '.claude'))) {
      return dir;
    }
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

/**
 * Resolve a file path to absolute form and verify it starts with an allowed prefix.
 * Uses path.resolve() to handle relative paths and '..' traversal (AC-14.1, AC-14.4).
 *
 * @param {string} filePath - The file path from tool_input
 * @param {string} projectRoot - Absolute path to project root
 * @param {string[]} allowedPrefixes - Relative prefixes to allow
 * @returns {{ allowed: boolean, resolvedPath: string, matchedPrefix: string | null }}
 */
function checkPathAgainstAllowlist(filePath, projectRoot, allowedPrefixes) {
  // Resolve to absolute path (handles ../ traversal and relative paths)
  const resolvedPath = resolve(projectRoot, filePath);

  // Check each prefix
  for (const prefix of allowedPrefixes) {
    const absolutePrefix = resolve(projectRoot, prefix);
    if (resolvedPath.startsWith(absolutePrefix)) {
      return { allowed: true, resolvedPath, matchedPrefix: prefix };
    }
  }

  return { allowed: false, resolvedPath, matchedPrefix: null };
}

/**
 * Read and validate the sentinel file.
 * Returns null if sentinel doesn't exist or is from a different session.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {string} currentSessionId - Current session ID from stdin
 * @returns {{ agent_type: string, session_id: string, timestamp: string } | null}
 */
function readSentinel(projectRoot, currentSessionId) {
  const sentinelPath = join(projectRoot, SENTINEL_RELATIVE_PATH);
  if (!existsSync(sentinelPath)) {
    return null;
  }

  try {
    const content = JSON.parse(readFileSync(sentinelPath, 'utf-8'));
    // Stale sentinel protection: ignore sentinels from different sessions
    if (content.session_id !== currentSessionId) {
      return null;
    }
    return content;
  } catch {
    // Malformed sentinel: treat as absent (fail-open)
    return null;
  }
}

/**
 * Write the sentinel file.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {string} sessionId - Current session ID
 */
function writeSentinel(projectRoot, sessionId) {
  const sentinelPath = join(projectRoot, SENTINEL_RELATIVE_PATH);
  const coordDir = join(projectRoot, '.claude', 'coordination');

  // Ensure coordination directory exists
  if (!existsSync(coordDir)) {
    mkdirSync(coordDir, { recursive: true });
  }

  const sentinelData = {
    agent_type: 'e2e-test-writer',
    session_id: sessionId,
    timestamp: new Date().toISOString(),
  };

  writeFileSync(sentinelPath, JSON.stringify(sentinelData, null, 2) + '\n');
}

/**
 * Delete the sentinel file if it exists.
 *
 * @param {string} projectRoot - Absolute path to project root
 */
function deleteSentinel(projectRoot) {
  const sentinelPath = join(projectRoot, SENTINEL_RELATIVE_PATH);
  if (existsSync(sentinelPath)) {
    try {
      unlinkSync(sentinelPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Output a blocking message to stderr and exit with code 2.
 *
 * @param {string} operation - "read" or "write"
 * @param {string} resolvedPath - The resolved absolute file path
 * @param {string[]} allowedPrefixes - The allowlist that was checked
 */
function blockOperation(operation, resolvedPath, allowedPrefixes) {
  process.stderr.write('\n');
  process.stderr.write('========================================\n');
  process.stderr.write('BLOCKED: E2E Black-Box Enforcement\n');
  process.stderr.write('========================================\n');
  process.stderr.write('\n');
  process.stderr.write(`Cannot ${operation} file: ${resolvedPath}\n`);
  process.stderr.write('\n');
  process.stderr.write(`The e2e-test-writer agent is restricted to black-box testing.\n`);
  process.stderr.write(`Allowed ${operation} paths:\n`);
  for (const prefix of allowedPrefixes) {
    process.stderr.write(`  - ${prefix}\n`);
  }
  process.stderr.write('\n');
  process.stderr.write('To resolve: Only access files within the allowed directories.\n');
  process.stderr.write('Implementation source code is off-limits for E2E test generation.\n');
  process.stderr.write('\n');
  process.exit(2);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      process.exit(0); // No input, fail-open
    }

    const input = JSON.parse(raw);
    const toolName = input.tool_name;
    const toolInput = input.tool_input || {};
    const sessionId = input.session_id || '';
    const projectRoot = findProjectRoot();

    // === Hook 1: Agent matcher ===
    if (toolName === 'Agent' || toolName === 'Task') {
      const subagentType = toolInput.subagent_type;

      if (subagentType === 'e2e-test-writer') {
        // Write sentinel to activate enforcement for this session
        writeSentinel(projectRoot, sessionId);
        process.stderr.write('[e2e-blackbox] Sentinel activated for e2e-test-writer session\n');
      } else {
        // A non-e2e-test-writer agent is being dispatched — the e2e session
        // is over (or was never active). Clean up any lingering sentinel to
        // prevent spurious enforcement for subsequent operations.
        deleteSentinel(projectRoot);
      }

      // Always allow Agent dispatches (this hook only manages the sentinel)
      process.exit(0);
    }

    // === Hook 2 & 3: Read / Write / Edit matcher ===
    // Check if sentinel is active for this session
    const sentinel = readSentinel(projectRoot, sessionId);
    if (!sentinel) {
      // No active e2e-test-writer session -- no enforcement needed.
      // If a sentinel file exists but readSentinel returned null, it's stale
      // (session_id mismatch). Clean it up to prevent future stat checks.
      const sentinelPath = join(projectRoot, SENTINEL_RELATIVE_PATH);
      if (existsSync(sentinelPath)) {
        deleteSentinel(projectRoot);
        process.stderr.write('[e2e-blackbox] Cleaned up stale sentinel from different session\n');
      }
      process.exit(0);
    }

    // Sentinel is active -- enforce allowlists
    const filePath = toolInput.file_path;
    if (!filePath) {
      process.exit(0); // No file path in input, fail-open
    }

    // Determine if this is a read or write operation
    const isWriteOperation = toolName === 'Write' || toolName === 'Edit';
    const isReadOperation = toolName === 'Read';

    if (isReadOperation) {
      const result = checkPathAgainstAllowlist(filePath, projectRoot, READ_ALLOWLIST_PREFIXES);
      if (!result.allowed) {
        blockOperation('read', result.resolvedPath, READ_ALLOWLIST_PREFIXES);
      }
    } else if (isWriteOperation) {
      const result = checkPathAgainstAllowlist(filePath, projectRoot, WRITE_ALLOWLIST_PREFIXES);
      if (!result.allowed) {
        blockOperation('write', result.resolvedPath, WRITE_ALLOWLIST_PREFIXES);
      }
    }

    // Operation allowed
    process.exit(0);

  } catch (error) {
    // Fail-open on any structural error
    process.stderr.write(`[e2e-blackbox] Error (fail-open): ${error.message}\n`);
    process.exit(0);
  }
}

main();
