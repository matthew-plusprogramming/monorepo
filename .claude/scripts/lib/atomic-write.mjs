/**
 * Atomic JSON Write Module
 *
 * Provides atomic read-modify-write for JSON files using:
 * 1. Lockfile acquisition (via session-lock.mjs)
 * 2. Write to temporary file in the same directory
 * 3. Atomic rename (temp -> target)
 * 4. Lockfile release
 *
 * On rename failure, triggers corruption recovery (fresh session, counts=0).
 *
 * Implements: REQ-012 (AC-1.8, AC-1.10), REQ-023 (AC-1.9), REQ-033
 * Spec: sg-convergence-audit-enforcement
 */

import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireLock, releaseLock } from './session-lock.mjs';

/**
 * Read a JSON file, returning parsed content or null on any error.
 * On corrupt JSON (AC-1.9), returns null so the caller can create a fresh session.
 *
 * @param {string} filePath - Absolute path to the JSON file
 * @returns {object|null} Parsed JSON object, or null if file missing/corrupt
 */
export function readJSONSafe(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    // AC-1.9: Corrupt JSON -- caller must create fresh session
    process.stderr.write(
      `[atomic-write] WARNING: Corrupt JSON at ${filePath} -- returning null for fresh session creation\n`
    );
    return null;
  }
}

/**
 * Atomically write a JSON object to a file with lockfile protection.
 *
 * Steps:
 * 1. Acquire lockfile
 * 2. Write JSON to temp file (same directory for atomic rename)
 * 3. Rename temp -> target (atomic on same filesystem)
 * 4. Release lockfile
 *
 * On rename failure (AC-1.10), triggers corruption recovery.
 *
 * @param {string} filePath - Absolute path to the target JSON file
 * @param {object} data - JSON-serializable object to write
 * @param {object} [lockOpts] - Options passed to acquireLock
 * @param {boolean} [lockOpts.failOpen=true] - Lock failure behavior
 * @returns {boolean} true if write succeeded, false if lock acquisition failed (fail-open)
 */
export function atomicWriteJSON(filePath, data, lockOpts = {}) {
  const dir = dirname(filePath);
  const lockPath = filePath + '.lock';

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Step 1: Acquire lock
  const lockAcquired = acquireLock(lockPath, lockOpts);
  if (!lockAcquired) {
    // Lock acquisition failed (fail-open mode)
    return false;
  }

  try {
    // Step 2: Write to temp file
    const tempPath = filePath + '.tmp.' + process.pid;
    const content = JSON.stringify(data, null, 2) + '\n';
    writeFileSync(tempPath, content);

    // Step 3: Atomic rename
    try {
      renameSync(tempPath, filePath);
    } catch (renameErr) {
      // AC-1.10: Rename failure -- trigger corruption recovery
      process.stderr.write(
        `[atomic-write] ERROR: Atomic rename failed -- OS error: ${renameErr.code || renameErr.message}, ` +
        `source: ${tempPath}, target: ${filePath}. Triggering corruption recovery.\n`
      );
      // Corruption recovery: write a fresh empty object
      try {
        writeFileSync(filePath, JSON.stringify({}, null, 2) + '\n');
      } catch {
        // Nothing more we can do
      }
      return false;
    }

    return true;
  } finally {
    // Step 4: Always release lock
    releaseLock(lockPath);
  }
}

/**
 * Atomically read-modify-write a JSON file.
 *
 * The modifier function receives the current JSON data (or null if missing/corrupt)
 * and must return the new data to write.
 *
 * @param {string} filePath - Absolute path to the JSON file
 * @param {function} modifier - (currentData: object|null) => object
 * @param {object} [lockOpts] - Options passed to acquireLock
 * @returns {boolean} true if write succeeded
 */
export function atomicModifyJSON(filePath, modifier, lockOpts = {}) {
  const dir = dirname(filePath);
  const lockPath = filePath + '.lock';

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Step 1: Acquire lock
  const lockAcquired = acquireLock(lockPath, lockOpts);
  if (!lockAcquired) {
    return false;
  }

  try {
    // Step 2: Read current data
    const currentData = readJSONSafe(filePath);

    // Step 3: Apply modifier
    const newData = modifier(currentData);

    // Step 4: Write to temp file
    const tempPath = filePath + '.tmp.' + process.pid;
    const content = JSON.stringify(newData, null, 2) + '\n';
    writeFileSync(tempPath, content);

    // Step 5: Atomic rename
    try {
      renameSync(tempPath, filePath);
    } catch (renameErr) {
      process.stderr.write(
        `[atomic-write] ERROR: Atomic rename failed -- OS error: ${renameErr.code || renameErr.message}, ` +
        `source: ${tempPath}, target: ${filePath}. Triggering corruption recovery.\n`
      );
      try {
        writeFileSync(filePath, JSON.stringify({}, null, 2) + '\n');
      } catch {
        // Nothing more we can do
      }
      return false;
    }

    return true;
  } finally {
    releaseLock(lockPath);
  }
}
