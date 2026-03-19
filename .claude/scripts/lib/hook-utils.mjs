/**
 * Shared utility functions for workflow enforcement hooks.
 *
 * Centralizes duplicated logic (loadSession, loadOverrides, findMatchingOverride,
 * readStdin, findClaudeDir) so that gate-enforcement and stop-enforcement hooks
 * import from a single source of truth.
 *
 * Spec: sg-coercive-gate-enforcement (code review fix M1/M2)
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Constants
// =============================================================================

/** Maximum retries for reading gate-override.json on parse failure (REQ-015). */
const OVERRIDE_READ_MAX_RETRIES = 1;

/** Delay in milliseconds before retrying a failed file read (catches partial writes). */
const RETRY_DELAY_MS = 50;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Synchronous sleep for a given number of milliseconds.
 * Uses Atomics.wait on a SharedArrayBuffer for a true blocking delay
 * without busy-waiting.
 *
 * @param {number} ms - Milliseconds to sleep
 */
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read all stdin as a string.
 * @returns {Promise<string>} Raw stdin content
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Find the .claude directory by walking up from script location.
 * Uses fileURLToPath for correct URL-to-path conversion (security fix L2).
 *
 * @param {string} importMetaUrl - The import.meta.url of the calling module
 * @returns {string} Absolute path to .claude directory
 */
export function findClaudeDir(importMetaUrl) {
  const callerPath = fileURLToPath(importMetaUrl);
  let currentDir = dirname(resolve(callerPath));
  const root = '/';

  while (currentDir !== root) {
    const claudeDir = join(currentDir, '.claude');
    if (existsSync(claudeDir)) {
      return claudeDir;
    }
    if (basename(currentDir) === '.claude') {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return join(process.cwd(), '.claude');
}

/**
 * Load session.json with graceful fail-open.
 * Returns null on any read/parse failure (REQ-022, REQ-028).
 *
 * @param {string} sessionPath - Absolute path to session.json
 * @returns {object|null} Parsed session or null
 */
export function loadSession(sessionPath) {
  if (!existsSync(sessionPath)) {
    return null;
  }

  try {
    const content = readFileSync(sessionPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Read gate-override.json with retry on parse failure (REQ-015).
 * Includes a real delay before retry to handle partial writes.
 *
 * @param {string} overridePath - Absolute path to gate-override.json
 * @returns {Array|null} Overrides array or null
 */
export function loadOverrides(overridePath) {
  if (!existsSync(overridePath)) {
    return null;
  }

  for (let attempt = 0; attempt <= OVERRIDE_READ_MAX_RETRIES; attempt++) {
    try {
      const content = readFileSync(overridePath, 'utf-8');
      const data = JSON.parse(content);
      if (Array.isArray(data.overrides)) {
        return data.overrides;
      }
      return null;
    } catch {
      if (attempt >= OVERRIDE_READ_MAX_RETRIES) {
        return null;
      }
      // Real delay before retry to handle partial writes (code review fix H1)
      syncSleep(RETRY_DELAY_MS);
    }
  }

  return null;
}

/**
 * Check if a valid override exists for the given gate and session.
 * Returns the most recent matching override (by timestamp) or null.
 * Validates that timestamp is a parseable date (security fix M4).
 *
 * @param {Array} overrides - Overrides array from gate-override.json
 * @param {string} gateName - The gate name to check
 * @param {string} sessionId - Current session ID from stdin
 * @returns {object|null} Matching override or null
 */
export function findMatchingOverride(overrides, gateName, sessionId) {
  if (!overrides || !Array.isArray(overrides)) return null;

  const matching = overrides.filter(
    o => o && o.gate === gateName && o.session_id === sessionId &&
         typeof o.timestamp === 'string' && typeof o.rationale === 'string' &&
         !isNaN(new Date(o.timestamp).getTime()) // Security fix M4: validate timestamp
  );

  if (matching.length === 0) return null;

  // Sort by timestamp descending, pick the most recent
  matching.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return matching[0];
}
