#!/usr/bin/env node

/**
 * parse-review-silent-drop-checklist.mjs
 *
 * Extracts the silent-drop checklist answer from code-reviewer output and
 * validates it against the SilentDropChecklistAnswer Zod schema.
 *
 * Contract (AC-8, AC-13):
 *   - Input: code-reviewer markdown output containing
 *       <!-- silent-drop-checklist -->
 *       ```json
 *       { ... SilentDropChecklistAnswer ... }
 *       ```
 *   - The HTML-comment sentinel MUST be immediately followed (no blank line)
 *     by a fenced ```json block.
 *   - Parser selects the block by sentinel anchor — NOT "last fence" or
 *     "top-level key" heuristics.
 *
 * Usage:
 *   node parse-review-silent-drop-checklist.mjs <path-to-reviewer-output.md>
 *   node parse-review-silent-drop-checklist.mjs -  # read from stdin
 *
 * Exit codes:
 *   0 - Valid parse; prints single-line summary to stdout.
 *   1 - Parse failure with structured error code on stderr.
 *   2 - Invocation error (missing file, bad args).
 *
 * Structured error codes (stderr JSON):
 *   sentinel-missing      -- <!-- silent-drop-checklist --> not present
 *   fenced-block-missing  -- sentinel found but no ```json block follows
 *   schema-invalid        -- block parsed but Zod validation failed
 *   json-invalid          -- fenced block present but invalid JSON syntax
 *
 * Implements: REQ-F-008, AC-8.1 through AC-8.6.
 */

import { readFileSync, existsSync } from 'node:fs';
import { silentDropChecklistAnswerSchema } from './lib/silent-drop-schemas.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Sentinel that marks the silent-drop checklist block (AC-13.1). */
const SENTINEL = '<!-- silent-drop-checklist -->';

/** Exit code for successful parse. */
const EXIT_OK = 0;

/** Exit code for parse failure (structured error). */
const EXIT_PARSE_FAIL = 1;

/** Exit code for invocation error (usage, missing file). */
const EXIT_USAGE = 2;

// =============================================================================
// Block extraction
// =============================================================================

/**
 * Extract the fenced JSON block associated with the silent-drop sentinel.
 *
 * Algorithm:
 *   1. Scan input for SENTINEL.
 *   2. If not found -> return { error: 'sentinel-missing' }.
 *   3. Starting at the next line after SENTINEL, skip whitespace-only lines
 *      UNTIL we either hit a ```json opening fence or any other content.
 *      NOTE: AC-13.1 requires "no blank line between" -- we enforce that
 *      strictly: the very next line MUST be the opening fence.
 *   4. If opening fence not immediately after sentinel -> fenced-block-missing.
 *   5. Collect lines until closing ``` fence; return the body.
 *
 * @param {string} content - Raw markdown input
 * @returns {{ body: string } | { error: string, detail?: string }}
 */
export function extractChecklistBlock(content) {
  const lines = content.split(/\r?\n/);

  // Find sentinel line (exact match; no trailing whitespace tolerated per
  // "sentinel discipline" in code-reviewer.md).
  let sentinelIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === SENTINEL) {
      sentinelIndex = i;
      break;
    }
  }
  if (sentinelIndex === -1) {
    return { error: 'sentinel-missing' };
  }

  // AC-13.1: the fenced block SHALL be preceded immediately by the sentinel.
  // Emission rule (code-reviewer writer) is "no blank line between"; parser
  // reader is lenient (Postel's Law) — tolerates blank lines between the
  // sentinel and the opening fence so formatters that rewrap markdown don't
  // silently convert a valid block into a parse failure. Non-blank content
  // between sentinel and fence IS an error (would indicate the sentinel is
  // not anchoring this block).
  let openLineIndex = sentinelIndex + 1;
  while (openLineIndex < lines.length && lines[openLineIndex].trim() === '') {
    openLineIndex++;
  }
  if (openLineIndex >= lines.length) {
    return {
      error: 'fenced-block-missing',
      detail: 'sentinel is last non-blank content; no fenced block follows',
    };
  }
  const openLine = lines[openLineIndex].trimEnd();
  if (openLine !== '```json') {
    return {
      error: 'fenced-block-missing',
      detail: `expected "\`\`\`json" after sentinel, got ${JSON.stringify(openLine)}`,
    };
  }

  // Collect body lines until closing fence "```".
  const bodyLines = [];
  let closed = false;
  for (let j = openLineIndex + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trimEnd() === '```') {
      closed = true;
      break;
    }
    bodyLines.push(line);
  }

  if (!closed) {
    return {
      error: 'fenced-block-missing',
      detail: 'fence opened but never closed',
    };
  }

  return { body: bodyLines.join('\n') };
}

// =============================================================================
// Summary emission
// =============================================================================

/**
 * Format the one-line summary (AC-8.5).
 *
 * Fields:
 *   - applied
 *   - modules_touched_count
 *   - findings_count
 *   - advisory_suspects_count
 *   - annotations_used_count
 *   - truncation_present
 *
 * @param {object} parsed - Validated SilentDropChecklistAnswer
 * @returns {string} Single-line summary
 */
export function formatSummary(parsed) {
  const fields = [
    `applied=${parsed.applied}`,
    `modules_touched_count=${parsed.delivery_path_modules_touched.length}`,
    `findings_count=${parsed.findings.length}`,
    `advisory_suspects_count=${parsed.advisory_suspects.length}`,
    `annotations_used_count=${parsed.annotations_used.length}`,
    `truncation_present=${parsed.truncation ? 'true' : 'false'}`,
  ];
  return fields.join(' ');
}

// =============================================================================
// Core parse pipeline
// =============================================================================

/**
 * Parse a checklist answer from reviewer-output markdown.
 *
 * @param {string} content - Raw markdown input
 * @returns {
 *   | { ok: true, parsed: object }
 *   | { ok: false, error: string, detail?: string, field_path?: string }
 * }
 */
export function parseChecklist(content) {
  const extracted = extractChecklistBlock(content);
  if ('error' in extracted) {
    return { ok: false, error: extracted.error, detail: extracted.detail };
  }

  let raw;
  try {
    raw = JSON.parse(extracted.body);
  } catch (err) {
    return {
      ok: false,
      error: 'json-invalid',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const result = silentDropChecklistAnswerSchema.safeParse(raw);
  if (!result.success) {
    // AC-8.4: name the first invalid field path
    const firstIssue = result.error.issues[0];
    const fieldPath = firstIssue.path.join('.');
    return {
      ok: false,
      error: 'schema-invalid',
      detail: `${fieldPath}: ${firstIssue.message}`,
      field_path: fieldPath,
    };
  }

  return { ok: true, parsed: result.data };
}

// =============================================================================
// CLI entry point
// =============================================================================

async function readStdinFully() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('usage: parse-review-silent-drop-checklist.mjs <path|->\n');
    process.exit(EXIT_USAGE);
  }

  const src = args[0];
  let content;
  if (src === '-') {
    content = await readStdinFully();
  } else {
    if (!existsSync(src)) {
      process.stderr.write(
        JSON.stringify({
          error: 'input-missing',
          detail: `file not found: ${src}`,
        }) + '\n'
      );
      process.exit(EXIT_USAGE);
    }
    content = readFileSync(src, 'utf-8');
  }

  const result = parseChecklist(content);
  if (!result.ok) {
    process.stderr.write(
      JSON.stringify({
        error: result.error,
        detail: result.detail ?? null,
        field_path: result.field_path ?? null,
      }) + '\n'
    );
    process.exit(EXIT_PARSE_FAIL);
  }

  process.stdout.write(formatSummary(result.parsed) + '\n');
  process.exit(EXIT_OK);
}

// Only run when invoked directly (not when imported by tests).
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(
      JSON.stringify({
        error: 'unexpected',
        detail: err instanceof Error ? err.message : String(err),
      }) + '\n'
    );
    process.exit(EXIT_PARSE_FAIL);
  });
}
