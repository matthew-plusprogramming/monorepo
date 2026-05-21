/**
 * Pipeline-Efficiency Audit-Log Entry Schema
 *
 * Validates hash-chained audit-log entries appended to
 * `.claude/audit/pipeline-efficiency-changes.log` per spec
 * `sg-pipeline-efficiency-ws1-convergence-pruning` §Audit log entry schema
 * (spec.md:641-665) and NFR-5 (9 canonical named event classes spanning ws-1,
 * ws-2, and ws-3).
 *
 * Entries form a SHA-256 hash chain: each entry's `prev_hash` is the hex
 * digest of the prior entry (or the genesis anchor for seq=1). Chain
 * integrity is verified by `verify-audit-chain.mjs --include-rotations` at
 * completion-verifier + baseline-publication gates (REQ-014). This schema
 * validates entry *shape* only -- chain linkage is verified separately by
 * the verifier script.
 *
 * Validation lives at boundaries:
 *   - Audit-log writer / appender (as-022 `audit-log-append.mjs`)
 *   - `verify-audit-chain.mjs` (entry-shape preflight before hash check)
 *
 * Implements: AC3.3, AC3.4, AC3.6
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning
 * Parent task: Phase A — Task A3
 *
 * Investigation Pass 2 amendment (inv-schema-e2c47b, 2026-04-22):
 *   event_class enum expanded from 6 letter codes → 9 named strings to
 *   accommodate ws-2 sub-classes (`test_writer_unlock_refence`,
 *   `test_writer_unlock_misuse`) and ws-3 (`compute_hashes`). Legacy letter
 *   codes `"a"`..`"f"` are rejected to prevent dual-encoding ambiguity
 *   (AC3.6).
 */

// =============================================================================
// Shared primitives
// =============================================================================

/**
 * ISO-8601 UTC timestamp string.
 *
 * Accepts both second-precision and sub-second precision forms; trailing
 * `Z` is required. Mirrors the pattern in `silent-drop-schemas.mjs` and
 * `enforcement-config.schema.mjs` so the project has one canonical shape.
 */
const ISO8601_UTC_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

function makeValidationError(issues) {
  const message = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  const error = new Error(message || 'validation failed');
  error.name = 'ValidationError';
  error.issues = issues;
  return error;
}

function makeSuccess(data) {
  return { success: true, data };
}

function makeFailure(issues) {
  return { success: false, error: makeValidationError(issues) };
}

function makeStringRegexSchema(regex, message) {
  return Object.freeze({
    safeParse(value) {
      if (typeof value === 'string' && regex.test(value)) {
        return makeSuccess(value);
      }
      return makeFailure([{ path: [], message }]);
    },
    parse(value) {
      const result = this.safeParse(value);
      if (!result.success) throw result.error;
      return result.data;
    },
  });
}

function makeEnumSchema(values) {
  const valueSet = new Set(values);
  const enumObject = Object.fromEntries(values.map((value) => [value, value]));
  return Object.freeze({
    options: Object.freeze([...values]),
    enum: Object.freeze(enumObject),
    safeParse(value) {
      if (valueSet.has(value)) {
        return makeSuccess(value);
      }
      return makeFailure([
        {
          path: [],
          message: `expected one of: ${values.join(', ')}`,
        },
      ]);
    },
    parse(value) {
      const result = this.safeParse(value);
      if (!result.success) throw result.error;
      return result.data;
    },
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const iso8601UtcSchema = makeStringRegexSchema(
  ISO8601_UTC_REGEX,
  'must be ISO-8601 UTC (Z suffix)'
);

/**
 * SHA-256 hex digest (64 lowercase hex chars).
 *
 * Used for `prev_hash`. The genesis-anchor entry (seq=0) is handled by
 * the genesis schema (REQ-014, Task E3); this schema accepts only the
 * hex-digest form for entries seq ≥ 1.
 */
export const sha256HexSchema = makeStringRegexSchema(
  SHA256_HEX_REGEX,
  'must be 64 lowercase hex chars (SHA-256 hex)'
);

// =============================================================================
// Event-class enum (9 canonical named strings; NFR-5)
// =============================================================================

/**
 * Canonical 9-class event_class enum per spec.md:651-659.
 *
 * Ordering follows the spec source verbatim. Additions require parent-spec
 * amendment (spec.md:643: "enum is extensible but additions require
 * parent-spec amendment"). Letter-code fallback (`a`..`f`) is intentionally
 * NOT accepted (AC3.6).
 *
 * Note: `test_writer_unlock_refence` is the correct spelling per the
 * canonical enum (spec.md:653, as-003:50). Do NOT "fix" to `reference` --
 * the enum value is contractually fixed.
 */
export const EVENT_CLASSES = [
  'flag_flip',
  'test_writer_unlock',
  'test_writer_unlock_refence',
  'test_writer_unlock_misuse',
  'atomizer_cleanup',
  'session_override_flip',
  'worktree_path_violation',
  'sentinel_lifecycle',
  'compute_hashes',
];

/** Enum: event_class in canonical 9 named strings. */
export const eventClassSchema = makeEnumSchema(EVENT_CLASSES);

// =============================================================================
// Actor enum
// =============================================================================

/** Enum: actor in {operator, agent} (spec.md:662). */
export const actorSchema = makeEnumSchema(['operator', 'agent']);

// =============================================================================
// Audit-entry schema
// =============================================================================

/**
 * AuditLogEntry -- entry in `.claude/audit/pipeline-efficiency-changes.log`.
 *
 * Shape per spec.md:645-665:
 *   - seq           -- monotonic non-negative integer (0 = genesis; 1+ = normal)
 *   - prev_hash     -- SHA-256 hex digest of the prior entry (chain linkage)
 *   - timestamp     -- ISO-8601 UTC
 *   - event_class   -- one of 9 canonical named strings (NFR-5)
 *   - event_subtype -- human-readable qualifier, e.g., "mode-flip-advisory-to-coercive"
 *   - actor         -- operator | agent
 *   - payload       -- event-specific object (shape not constrained here;
 *                      per-event validation is the writer's concern)
 *
 * `.strict()` rejects unknown top-level keys to prevent silent schema drift.
 * Payload is `z.record(z.unknown())` -- a plain object of any shape; arrays
 * and primitives are rejected. Per-event payload shapes are validated by
 * the writer (as-022) in a follow-on spec.
 *
 * Invariants enforced here:
 *   - seq ≥ 0                                  (AC3.4: negative seq rejected)
 *   - event_class ∈ canonical 9 named strings  (AC3.4, AC3.6: unknown + letter-codes rejected)
 *   - timestamp is ISO-8601 UTC
 *   - prev_hash is SHA-256 hex
 *
 * Invariants NOT enforced here (delegated to verifier / writer):
 *   - prev_hash actually matches the prior entry's computed hash (verify-audit-chain.mjs)
 *   - seq is exactly prior_seq + 1 (appender responsibility)
 *   - payload shape per event_class (writer responsibility; future spec)
 */
export const auditEntrySchema = Object.freeze({
  safeParse(raw) {
    if (!isPlainObject(raw)) {
      return makeFailure([{ path: [], message: 'expected object' }]);
    }

    const issues = [];
    const allowedKeys = new Set([
      'seq',
      'prev_hash',
      'timestamp',
      'event_class',
      'event_subtype',
      'actor',
      'payload',
    ]);
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) {
        issues.push({ path: [key], message: 'unknown key' });
      }
    }

    if (!Number.isInteger(raw.seq) || raw.seq < 0) {
      issues.push({ path: ['seq'], message: 'seq must be a non-negative integer' });
    }

    const prevHash = sha256HexSchema.safeParse(raw.prev_hash);
    if (!prevHash.success) {
      issues.push({ path: ['prev_hash'], message: prevHash.error.message });
    }

    const timestamp = iso8601UtcSchema.safeParse(raw.timestamp);
    if (!timestamp.success) {
      issues.push({ path: ['timestamp'], message: timestamp.error.message });
    }

    const eventClass = eventClassSchema.safeParse(raw.event_class);
    if (!eventClass.success) {
      issues.push({ path: ['event_class'], message: eventClass.error.message });
    }

    if (typeof raw.event_subtype !== 'string' || raw.event_subtype.length === 0) {
      issues.push({
        path: ['event_subtype'],
        message: 'event_subtype must be a non-empty string',
      });
    }

    const actor = actorSchema.safeParse(raw.actor);
    if (!actor.success) {
      issues.push({ path: ['actor'], message: actor.error.message });
    }

    const payload = raw.payload === undefined ? {} : raw.payload;
    if (!isPlainObject(payload)) {
      issues.push({ path: ['payload'], message: 'payload must be an object' });
    }

    if (issues.length > 0) {
      return makeFailure(issues);
    }

    return makeSuccess({
      seq: raw.seq,
      prev_hash: raw.prev_hash,
      timestamp: raw.timestamp,
      event_class: raw.event_class,
      event_subtype: raw.event_subtype,
      actor: raw.actor,
      payload: { ...payload },
    });
  },
  parse(raw) {
    const result = this.safeParse(raw);
    if (!result.success) throw result.error;
    return result.data;
  },
});

// =============================================================================
// Type exports for JSDoc / consumer ergonomics
// =============================================================================

/** @typedef {{seq: number, prev_hash: string, timestamp: string, event_class: EventClass, event_subtype: string, actor: Actor, payload: Record<string, unknown>}} AuditLogEntry */
/** @typedef {'flag_flip' | 'test_writer_unlock' | 'test_writer_unlock_refence' | 'test_writer_unlock_misuse' | 'atomizer_cleanup' | 'session_override_flip' | 'worktree_path_violation' | 'sentinel_lifecycle' | 'compute_hashes'} EventClass */
/** @typedef {'operator' | 'agent'} Actor */
