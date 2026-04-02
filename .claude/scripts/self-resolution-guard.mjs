#!/usr/bin/env node

/**
 * Observable-behavior guard CLI validation tool.
 *
 * Scans the self-resolution audit trail for entries where tier=4 (reasoning)
 * AND the question/resolution matches observable-behavior patterns.
 * These are violations of the self-answer protocol: agents should escalate
 * rather than self-resolve when only reasoning-tier evidence exists for
 * observable behavior questions.
 *
 * Usage:
 *   node self-resolution-guard.mjs validate
 *
 * Environment:
 *   AUDIT_DIR - Override audit directory path (default: .claude/audit)
 *
 * Exit codes:
 *   0 - Clean (no violations found)
 *   1 - Violations found OR structural error (missing file, malformed JSONL)
 *
 * Spec: sg-self-answering-agents
 * ACs: AC-8.1, AC-8.2, AC-8.3, AC-8.4, AC-8.5
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Constants (AC-8.5)
// =============================================================================

/**
 * Observable behavior pattern definitions that trigger the guard.
 * Each entry pairs a regex pattern with its human-readable keyword.
 * Consolidating pattern + keyword in one array prevents parallel-array drift.
 *
 * Required patterns (per AC-8.5): exit code, output format, file write,
 * api response, error message, user visible, stdout, stderr, return value,
 * http status.
 */
const OBSERVABLE_BEHAVIOR_DEFINITIONS = [
  { pattern: /exit[\s._-]*code/i, keyword: 'exit code' },
  { pattern: /output[\s._-]*format/i, keyword: 'output format' },
  { pattern: /file[\s._-]*write/i, keyword: 'file write' },
  { pattern: /api[\s._-]*response/i, keyword: 'api response' },
  { pattern: /error[\s._-]*message/i, keyword: 'error message' },
  { pattern: /user[\s._-]*visible/i, keyword: 'user visible' },
  { pattern: /\bstdout\b/i, keyword: 'stdout' },
  { pattern: /\bstderr\b/i, keyword: 'stderr' },
  { pattern: /return[\s._-]*value/i, keyword: 'return value' },
  { pattern: /http[\s._-]*status/i, keyword: 'http status' },
];

/**
 * Exported regex array for backward compatibility with tests (AC-8.5).
 */
export const OBSERVABLE_BEHAVIOR_PATTERNS = OBSERVABLE_BEHAVIOR_DEFINITIONS.map(
  (d) => d.pattern
);

// =============================================================================
// Validation Logic
// =============================================================================

/**
 * Check if a text matches any observable behavior pattern.
 *
 * @param {string} text - Text to check
 * @returns {string|null} The matched pattern keyword, or null
 */
function matchesObservableBehavior(text) {
  if (!text || typeof text !== 'string') return null;

  for (const { pattern, keyword } of OBSERVABLE_BEHAVIOR_DEFINITIONS) {
    if (pattern.test(text)) {
      return keyword;
    }
  }
  return null;
}

/**
 * Validate the audit trail for observable-behavior violations.
 *
 * @param {string} auditDir - Directory containing the audit file
 * @returns {{ violations: Array<object>, errors: string[], clean: boolean }}
 */
function validateAuditTrail(auditDir) {
  const auditFilePath = join(auditDir, 'self-resolutions.jsonl');

  // Check file exists (AC-8.3)
  if (!existsSync(auditFilePath)) {
    return {
      violations: [],
      errors: [`Audit trail file does not exist: ${auditFilePath}`],
      clean: false,
    };
  }

  const content = readFileSync(auditFilePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return { violations: [], errors: [], clean: true };
  }

  // Parse entries (AC-8.3 - malformed JSONL handling)
  const entries = [];
  const parseErrors = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      parseErrors.push(`Malformed JSONL at line ${i + 1}: ${lines[i].slice(0, 50)}...`);
    }
  }

  if (parseErrors.length > 0 && entries.length === 0) {
    return {
      violations: [],
      errors: parseErrors,
      clean: false,
    };
  }

  // Scan for violations: tier=4 + observable behavior (AC-8.2)
  // Only flag tier 4 (reasoning). Tier 1-3 are NOT violations (AC-8.4)
  const violations = [];

  for (const entry of entries) {
    if (entry.type !== 'resolution' || entry.tier !== 4) continue;

    // Check question and resolution against patterns
    const questionMatch = matchesObservableBehavior(entry.question);
    const resolutionMatch = matchesObservableBehavior(entry.resolution);
    const matched = questionMatch || resolutionMatch;

    if (matched) {
      violations.push({
        entry_id: entry.entry_id,
        agent: entry.agent,
        tier: entry.tier,
        matched_pattern: matched,
        question: entry.question,
        resolution: entry.resolution,
      });
    }
  }

  return {
    violations,
    errors: parseErrors,
    clean: violations.length === 0 && parseErrors.length === 0,
  };
}

// =============================================================================
// CLI Entry Point (guarded: only runs when script is invoked directly)
// =============================================================================

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'validate') {
    const auditDir =
      process.env.AUDIT_DIR || join(process.cwd(), '.claude', 'audit');

    const result = validateAuditTrail(auditDir);

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(`ERROR: ${err}`);
      }
      if (result.violations.length === 0 && result.errors.length > 0) {
        // Structural error only
        process.exit(1);
      }
    }

    if (result.violations.length > 0) {
      console.log(
        `Found ${result.violations.length} observable-behavior violation(s):`
      );
      for (const v of result.violations) {
        console.log(
          `  - entry_id=${v.entry_id} agent=${v.agent} pattern="${v.matched_pattern}" question="${v.question}"`
        );
      }
      process.exit(1);
    }

    if (result.clean) {
      console.log('Clean: no observable-behavior violations found.');
      process.exit(0);
    }

    // Fallback: errors present but also some entries parsed
    process.exit(1);
  } else {
    console.error('Usage: self-resolution-guard.mjs validate');
    process.exit(1);
  }
}
