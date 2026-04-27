/**
 * audit-chain.mjs — shared canonicalization + sanitization primitives for the
 * kill-switch audit log.
 *
 * Audit-chain canonicalization contract:
 *   Consolidates byte-identical copies of `canonicalJSON` and
 *   `CONTROL_CHAR_REGEX` previously duplicated across:
 *     - .claude/scripts/audit-append.mjs
 *     - .claude/scripts/audit-verify.mjs
 *
 *   Drift between those two canonicalJSON implementations would emit
 *   false-positive tamper reports on every well-formed entry
 *   (see sec-crypto-9a2e1506). A single source of truth eliminates the
 *   drift surface.
 *
 * @req REQ-009.3 (chain integrity)
 * @sec sec-crypto-9a2e1506, sec-input-ff2a1d47
 */

/**
 * Canonicalize an object for hashing: recursively sorted keys at every nesting
 * level, no whitespace (stable prev_hash chain semantics per AC1.5).
 *
 * cr-quality-6d8f029c / sec-crypto-9a2e1506 / sec-cryptochain-a3f21b8e:
 *   The prev_hash chain is a Merkle-like hash chain — each entry's prev_hash
 *   binds to the SHA-256 of the previous entry's canonical JSON. Correct
 *   canonicalization must sort keys at EVERY nesting level, not just the top
 *   level. A shallow sort leaves nested `payload` objects ordering-dependent:
 *   two agents producing the same logical entry with different payload key
 *   insertion orders would compute different prev_hash values and diverge the
 *   chain. Recursively rebuild with sorted keys so byte-identical output is
 *   guaranteed for any input-order permutation of the same logical entry,
 *   regardless of depth.
 *
 *   Arrays preserve positional semantics — order is part of the value. We
 *   recurse into array elements but do NOT sort them. Primitives (string /
 *   number / boolean / null) pass through unchanged. `undefined` values inside
 *   arrays are serialized as `null` by JSON.stringify; `undefined` object
 *   property values are dropped — this matches the stdlib contract and is
 *   what the hash chain already depended on.
 *
 *   Note: JSON.stringify(obj, replacer) second argument is NOT a key-ordering
 *   hint — V8 emits keys in insertion order regardless. Any future refactor
 *   that tries to reorder via the replacer argument would silently break
 *   chain verification.
 *
 *   Historical note: entries written before this recursive fix used a
 *   top-level-only sort. Entries whose payload already emitted keys in sorted
 *   order are byte-identical under the new canonicalizer; entries whose
 *   payload keys happened to be inserted out-of-order will now produce a
 *   different canonical form (and therefore a different prev_hash for the
 *   next link). This is the intended correction — the prior output was the
 *   bug.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJSON(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Recursively rebuild the value with object keys sorted at every depth.
 * Arrays retain positional order but their elements are recursed into.
 * Non-object values pass through unchanged.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map((element) => sortKeysDeep(element));
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Control chars rejected unconditionally in actor/rationale fields
 * (0x00-0x1F, except 0x09 TAB).
 *
 * sec-input-ff2a1d47: also rejects Unicode line/paragraph separators and
 * bidirectional overrides. These would otherwise pass ASCII-range screening
 * while still enabling:
 *   U+2028/U+2029 — logical line breaks in JSON parsers and JS eval paths
 *   U+202A-U+202E — bidi overrides (rationale spoofing in UI render)
 *   U+200E/U+200F — LTR/RTL marks (invisible direction hijack)
 *
 * Consumers MUST NFC-normalize input before applying this regex so composed /
 * decomposed sequences match identically.
 */
export const CONTROL_CHAR_REGEX =
  /[\x00-\x08\x0A-\x1F\u2028\u2029\u202A-\u202E\u200E\u200F]/;
