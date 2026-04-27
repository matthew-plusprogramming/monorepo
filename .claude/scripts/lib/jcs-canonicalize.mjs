/**
 * RFC 8785 JCS (JSON Canonicalization Scheme) -- Inline Implementation
 *
 * Deterministic key-ordering + minimal JSON serialization for hash-chain
 * integrity in the AuditLogEntry audit log.
 *
 * Scope: Fixed-schema objects without floats requiring IEEE-754 normalization.
 * Strings are NFC-normalized per RFC 8785 section 3.2.3 (T2.X additive
 * extension, sg-e2e-enforcement-flag-audit as-002) so canonically-equivalent
 * Unicode strings (decomposed vs precomposed forms) produce byte-identical
 * canonical output.
 *
 * Reference: RFC 8785 section 3.2
 * Implements: AC-14.7 (hash-chain canonicalization), AC2.5 / T2.X (NFC)
 */

/**
 * Canonicalize a JSON-serializable value per RFC 8785.
 *
 * Rules applied:
 * - Objects: keys sorted lexicographically, no whitespace
 * - Arrays: elements in original order
 * - Strings: Unicode NFC-normalized, then JSON-escaped (T2.X, as-002 AC2.5)
 * - Numbers: shortest representation (no trailing zeros)
 * - null, true, false: literal
 *
 * NFC note (T2.X additive extension, sg-e2e-enforcement-flag-audit as-002):
 *   Strings are normalized to Unicode NFC BEFORE JSON-escape so two
 *   canonically-equivalent forms (e.g., "e" + COMBINING ACUTE ACCENT vs
 *   precomposed "é") produce identical output. Non-string values (null,
 *   boolean, number, array, object) are unchanged by the extension. Object
 *   keys are also NFC-normalized before emission.
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
  // T2.X (as-002 AC2.5): NFC-normalize strings before JSON-escape so
  // decomposed + precomposed Unicode forms yield byte-identical output.
  if (type === 'string') return JSON.stringify(value.normalize('NFC'));

  if (Array.isArray(value)) {
    const items = value.map((item) => jcsCanonicalize(item));
    return '[' + items.join(',') + ']';
  }

  if (type === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map(
      (k) => JSON.stringify(k.normalize('NFC')) + ':' + jcsCanonicalize(value[k]),
    );
    return '{' + pairs.join(',') + '}';
  }

  // Fallback for unexpected types
  return JSON.stringify(value);
}

/**
 * Canonicalize `obj` with `excludedKey` dropped prior to canonicalization.
 *
 * Shallow-clones the input (caller's object is NOT mutated — AC2.6),
 * deletes `excludedKey` from the clone, then delegates to `jcsCanonicalize`.
 * If the key is absent the helper is a no-op (AC2.2).
 *
 * Used by the enforcement audit log writer + verifier to compute `prev_hash`
 * over the entry body minus its own `prev_hash` field.
 *
 * Implements: sg-e2e-enforcement-flag-audit as-002 AC2.1, AC2.2, AC2.6.
 *
 * @param {Record<string, unknown>} obj - Plain object.
 * @param {string} excludedKey - Name of the field to drop before canonicalize.
 * @returns {string} Canonical JSON string of obj minus excludedKey.
 */
export function canonicalizeExcludingField(obj, excludedKey) {
  const clone = { ...obj };
  delete clone[excludedKey];
  return jcsCanonicalize(clone);
}
