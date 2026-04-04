/**
 * Canonical Findings Hash Computation
 *
 * Computes a deterministic SHA-256 hash of finding IDs by sorting them
 * lexicographically and hashing the resulting JSON array string.
 *
 * Implements: REQ-013 (AC-1.6)
 * Spec: sg-convergence-audit-enforcement
 */

import { createHash } from 'node:crypto';

/**
 * Compute a canonical SHA-256 hash from an array of finding ID strings.
 *
 * The canonical form is: sort the IDs lexicographically, JSON.stringify
 * the sorted array, then SHA-256 hash the UTF-8 encoding of that string.
 *
 * @param {string[]} findingIds - Array of finding ID strings (unsorted)
 * @returns {string} Hex-encoded SHA-256 hash (64 characters)
 */
export function computeFindingsHash(findingIds) {
  const sorted = [...findingIds].sort();
  const canonical = JSON.stringify(sorted);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
