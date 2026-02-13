#!/usr/bin/env node

/**
 * Validate convergence fields in manifest.json files.
 *
 * Checks that all keys in the `convergence` object are canonical field names.
 * Provides suggestions for common aliases/misspellings.
 *
 * Ported from ai-eng-dashboard with adaptations:
 * - Blocks on non-canonical fields (exit 1)
 * - Extended alias map per spec Non-Canonical Alias Map table
 * - traceability_complete maps to unifier_passed (DEC-003)
 * - test_coverage flagged as not-a-gate
 * - No hardcoded project-specific paths
 *
 * Usage:
 *   node validate-convergence-fields.mjs <manifest.json>
 *
 * Exit codes:
 *   0 - Valid (no convergence, empty convergence, all fields canonical)
 *   1 - Error (missing args, file not found, parse error, or non-canonical fields found)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// AC2.3: Exactly 8 canonical convergence field names
const CANONICAL_FIELDS = new Set([
  'spec_complete',
  'all_acs_implemented',
  'all_tests_passing',
  'unifier_passed',
  'code_review_passed',
  'security_review_passed',
  'browser_tests_passed',
  'docs_generated',
]);

// AC2.4: 20+ known non-canonical variants with alias suggestions
// Merged from ai-eng-dashboard source and spec Non-Canonical Alias Map table
const ALIASES = {
  // -> all_acs_implemented
  implemented: 'all_acs_implemented',
  implementation_complete: 'all_acs_implemented',
  impl_complete: 'all_acs_implemented',
  implementation_aligned: 'all_acs_implemented',
  all_acs_verified: 'all_acs_implemented',
  all_acs_complete: 'all_acs_implemented',
  acs_implemented: 'all_acs_implemented',

  // -> all_tests_passing
  tested: 'all_tests_passing',
  tests_passing: 'all_tests_passing',
  tests_complete: 'all_tests_passing',
  test_complete: 'all_tests_passing',
  all_tests_written: 'all_tests_passing',

  // -> unifier_passed (DEC-003: traceability_complete maps here)
  traceability_complete: 'unifier_passed',
  unified: 'unifier_passed',
  unify_passed: 'unifier_passed',
  unification_complete: 'unifier_passed',
  unifier_complete: 'unifier_passed',

  // -> code_review_passed
  code_reviewed: 'code_review_passed',
  code_review_complete: 'code_review_passed',
  review_complete: 'code_review_passed',
  reviewed: 'code_review_passed',

  // -> security_review_passed
  security_reviewed: 'security_review_passed',
  security_review_complete: 'security_review_passed',

  // -> browser_tests_passed
  browser_tested: 'browser_tests_passed',
  browser_test_passed: 'browser_tests_passed',
  browser_test_complete: 'browser_tests_passed',

  // -> docs_generated
  documentation_complete: 'docs_generated',
  docs_complete: 'docs_generated',
  documented: 'docs_generated',
};

// Special case: test_coverage is not a convergence gate
const NOT_A_GATE = new Set([
  'test_coverage',
]);

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: validate-convergence-fields.mjs <manifest.json>');
    // Missing required argument is an error
    process.exit(1);
  }

  const filePath = resolve(args[0]);

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    // Missing file is an error
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`Invalid JSON in ${filePath}: ${err.message}`);
    // Parse error is an error
    process.exit(1);
  }

  // When manifest has no convergence object, nothing to validate
  if (!data.convergence || typeof data.convergence !== 'object') {
    process.exit(0);
  }

  // Inspect convergence object keys
  const nonCanonical = [];

  for (const key of Object.keys(data.convergence)) {
    if (!CANONICAL_FIELDS.has(key)) {
      nonCanonical.push(key);
    }
  }

  // All fields canonical or empty convergence - valid
  if (nonCanonical.length === 0) {
    process.exit(0);
  }

  // Warn with message suggesting the canonical alternative
  console.error(`ERROR: Non-canonical convergence fields in ${filePath}`);
  console.error('');

  for (const field of nonCanonical) {
    if (NOT_A_GATE.has(field)) {
      console.error(`  "${field}" -> Not a convergence gate. Remove from convergence object.`);
    } else {
      const suggestion = ALIASES[field];
      if (suggestion) {
        console.error(`  "${field}" -> Did you mean "${suggestion}"?`);
      } else {
        console.error(`  "${field}" -> Unknown convergence field -- remove or use a canonical name.`);
      }
    }
  }

  console.error('');
  console.error('Canonical convergence fields:');
  for (const field of CANONICAL_FIELDS) {
    console.error(`  - ${field}`);
  }

  // Exit 1 to block the edit until fixed
  process.exit(1);
}

main();
