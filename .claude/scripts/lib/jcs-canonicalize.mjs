/**
 * RFC 8785 JCS (JSON Canonicalization Scheme) -- Inline Implementation
 *
 * Deterministic key-ordering + minimal JSON serialization for hash-chain
 * integrity in the AuditLogEntry audit log.
 *
 * Scope: Fixed-schema objects without floats or unicode requiring normalization.
 * For the AuditLogEntry use case this ~30-line function is sufficient.
 *
 * Reference: RFC 8785 section 3.2
 * Implements: AC-14.7 (hash-chain canonicalization)
 * Spec: sg-deployment-verification-gaps
 */

/**
 * Canonicalize a JSON-serializable value per RFC 8785.
 *
 * Rules applied:
 * - Objects: keys sorted lexicographically, no whitespace
 * - Arrays: elements in original order
 * - Strings: JSON-escaped
 * - Numbers: shortest representation (no trailing zeros)
 * - null, true, false: literal
 *
 * @param {unknown} value - JSON-serializable value
 * @returns {string} Canonical JSON string (no whitespace)
 */
export function jcsCanonicalize(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'null';

  const type = typeof value;

  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') return JSON.stringify(value);
  if (type === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    const items = value.map((item) => jcsCanonicalize(item));
    return '[' + items.join(',') + ']';
  }

  if (type === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ':' + jcsCanonicalize(value[k]));
    return '{' + pairs.join(',') + '}';
  }

  // Fallback for unexpected types
  return JSON.stringify(value);
}
