/**
 * Test Baseline Schema Validator
 *
 * Validates `.claude/test-baseline.json` against the REQ-006 schema and
 * provides the repo-level parsing utility consumed by
 * `.claude/scripts/test-baseline-check.mjs` (as-022) and
 * `.claude/scripts/test-baseline-update.mjs` (as-023).
 *
 * Schema (REQ-006.1):
 *   {
 *     version: 1,
 *     entries: Array<{
 *       file: string,                  // repo-relative test file path
 *       test: string,                  // fully-qualified test name
 *       reason?: string,               // categorization tag (e.g., "inherited-baseline")
 *       added_date: string             // ISO 8601 timestamp
 *     }>
 *   }
 *
 * Fail-closed semantics (REQ-006.6):
 *   - Unknown `version` -> throw Error with text naming the unknown value.
 *   - Corrupt JSON -> throw Error with text
 *     `test-baseline.json parse failure; re-generate or revert`.
 *   - Missing required field -> throw Error identifying the missing field.
 *
 * Refresh log (REQ-006 / DEC-CHK-010):
 *   `.claude/test-baseline.refresh-log.jsonl` is append-only JSONL; each line
 *   is either an entry-record (`{action: "removed"|"added", file, test, reason,
 *   refresh_date}`) or a summary record (`{action: "summary", refresh_date,
 *   removed_count, added_count, pre_refresh_entry_count, post_refresh_entry_count}`).
 *
 * @req REQ-006
 * @contract test-baseline-schema
 */

import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';

export const SUPPORTED_VERSION = 1;

/**
 * Strict ISO 8601 pattern: `YYYY-MM-DDTHH:mm:ss(.sss)?(Z|+HH:MM|-HH:MM)`.
 *
 * `new Date(v)` is too permissive (accepts `"2026/04/18 00:00"`, etc.);
 * the spec requires ISO 8601 specifically, so we gate via regex first and
 * then confirm the parsed date is valid.
 */
export const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * ISO 8601 predicate used by the schema refine hook.
 */
export function isIso8601(v) {
  return typeof v === 'string' && ISO_8601_RE.test(v) && !Number.isNaN(new Date(v).getTime());
}

// =============================================================================
// Zod schemas
// =============================================================================

/**
 * A single baseline entry.
 *
 * - `file` and `test` together form the identity tuple used by exact-equality
 *   diff in `test-baseline-check.mjs`.
 * - `reason` is optional per REQ-006.1 (some operator-added entries may lack
 *   a categorization tag; bootstrap entries always carry `inherited-baseline`).
 * - `added_date` must be ISO 8601 (`new Date(...).toISOString()` shape).
 */
export const BaselineEntrySchema = z.object({
  file: z.string().min(1, 'entry.file is required'),
  test: z.string().min(1, 'entry.test is required'),
  reason: z.string().optional(),
  added_date: z
    .string()
    .min(1, 'entry.added_date is required')
    .refine(isIso8601, { message: 'entry.added_date must be a valid ISO 8601 timestamp' }),
});

/**
 * Full baseline document. `version` is a literal so unknown versions fail
 * fast with a clear message (REQ-006.6).
 */
export const TestBaselineSchema = z.object({
  version: z.literal(SUPPORTED_VERSION),
  entries: z.array(BaselineEntrySchema),
});

/**
 * Refresh-log records. Exported for downstream tests asserting log shape.
 *
 * Entry records cover add / remove events; summary records cover the per-
 * refresh-invocation batch totals appended at the end of a `--refresh` run.
 */
export const RefreshLogEntryRecordSchema = z.object({
  action: z.enum(['removed', 'added']),
  file: z.string().min(1),
  test: z.string().min(1),
  reason: z.string().min(1),
  refresh_date: z
    .string()
    .min(1)
    .refine(isIso8601, { message: 'refresh_date must be ISO 8601' }),
});

export const RefreshLogSummaryRecordSchema = z.object({
  action: z.literal('summary'),
  refresh_date: z
    .string()
    .min(1)
    .refine(isIso8601, { message: 'refresh_date must be ISO 8601' }),
  removed_count: z.number().int().nonnegative(),
  added_count: z.number().int().nonnegative(),
  pre_refresh_entry_count: z.number().int().nonnegative(),
  post_refresh_entry_count: z.number().int().nonnegative(),
});

export const RefreshLogRecordSchema = z.union([
  RefreshLogEntryRecordSchema,
  RefreshLogSummaryRecordSchema,
]);

// =============================================================================
// Parse / validate helpers
// =============================================================================

/**
 * Error subclass for fail-closed parse / validation failures. Carries a
 * structured `kind` so callers can branch on cause (bootstrap-missing vs
 * corrupt vs version-drift vs schema-violation) without string-matching.
 */
export class TestBaselineError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'TestBaselineError';
    this.kind = kind;
  }
}

/**
 * Parse + validate a baseline document from raw text.
 *
 * - Corrupt JSON -> TestBaselineError(kind='corrupt_json') with verbatim text
 *   `test-baseline.json parse failure; re-generate or revert` (AC1.3).
 * - Unknown version -> TestBaselineError(kind='unknown_version') naming the
 *   offending value (AC1.2).
 * - Schema violation -> TestBaselineError(kind='schema_violation') identifying
 *   the failing field path (AC1.1).
 *
 * @param {string} rawText
 * @param {object} [opts]
 * @param {string} [opts.sourceLabel]  Path shown in error messages.
 * @returns {{ version: number, entries: Array<object> }}
 */
export function parseBaseline(rawText, opts = {}) {
  const label = opts.sourceLabel || 'test-baseline.json';

  // Parse JSON
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new TestBaselineError(
      'test-baseline.json parse failure; re-generate or revert',
      'corrupt_json',
    );
  }

  // Pre-validate version so we can emit a targeted error before Zod reports
  // a more generic `version: Invalid literal value` message.
  if (parsed && typeof parsed === 'object' && 'version' in parsed) {
    if (parsed.version !== SUPPORTED_VERSION) {
      throw new TestBaselineError(
        `${label}: unknown version ${JSON.stringify(parsed.version)} (supported: ${SUPPORTED_VERSION})`,
        'unknown_version',
      );
    }
  }

  // Full schema validation
  const result = TestBaselineSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new TestBaselineError(
      `${label}: schema violation — ${issues}`,
      'schema_violation',
    );
  }
  return result.data;
}

/**
 * Load + validate the baseline from a file path.
 *
 * - File absent -> returns `null` (graceful-degradation caller signal per
 *   REQ-006.4; the check CLI converts null -> warning + exit 0).
 * - File present but invalid -> propagates the TestBaselineError (fail-closed).
 *
 * @param {string} filePath  Absolute path.
 * @returns {{ version: number, entries: Array<object> } | null}
 */
export function loadBaselineFile(filePath) {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf8');
  return parseBaseline(raw, { sourceLabel: filePath });
}

/**
 * Exact-equality identity for baseline entries: `(file, test)` tuple.
 * Used by the diff in `test-baseline-check.mjs` (as-022 AC1.1).
 *
 * @param {{file: string, test: string}} e
 */
export function entryKey(e) {
  return `${e.file}\u0000${e.test}`;
}

/**
 * Assertion-style wrapper used by the test-writer's expected API shape
 * (`mod.validateBaseline || mod.validate || mod.default`).
 *
 * Throws TestBaselineError on invalid shape; returns the parsed baseline
 * document on success.
 *
 * Accepts either a pre-parsed object (Zod-style validator) or a raw JSON
 * string (CLI-style).
 *
 * @param {object|string} input
 * @returns {{ version: number, entries: Array<object> }}
 */
export function validateBaseline(input) {
  if (typeof input === 'string') {
    return parseBaseline(input);
  }
  if (input && typeof input === 'object' && 'version' in input) {
    if (input.version !== SUPPORTED_VERSION) {
      throw new TestBaselineError(
        `test-baseline.json: unknown version ${JSON.stringify(input.version)} (supported: ${SUPPORTED_VERSION})`,
        'unknown_version',
      );
    }
  }
  const result = TestBaselineSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new TestBaselineError(
      `test-baseline.json: schema violation — ${issues}`,
      'schema_violation',
    );
  }
  return result.data;
}

// Default export matches `mod.default` shape in the test-writer's
// export probe (tries validateBaseline first, then validate, then default).
export default validateBaseline;

/**
 * Compose the refresh-log line for an append operation. Returned string
 * includes a trailing newline so callers can `appendFileSync` without
 * re-appending.
 */
export function formatRefreshLogLine(record) {
  // Validate before serializing so we never append a malformed record.
  const result = RefreshLogRecordSchema.safeParse(record);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new TestBaselineError(
      `refresh-log record invalid — ${issues}`,
      'refresh_log_shape',
    );
  }
  return JSON.stringify(result.data) + '\n';
}
