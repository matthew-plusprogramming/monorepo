#!/usr/bin/env node

/**
 * Validates spec markdown structure.
 *
 * Checks for:
 * - YAML frontmatter with required fields: id, title, date, status
 * - Required sections: Context, Goal, Requirements (or Requirements Summary),
 *   Acceptance Criteria (optional for high-level specs), Task List
 *
 * Usage:
 *   node spec-validate.mjs <file1.md> [file2.md ...]
 *
 * The script accepts file paths as arguments (passed via hook-wrapper.mjs).
 *
 * Exit codes:
 *   0 - All files pass validation
 *   1 - One or more files failed validation
 */

import { readFileSync, existsSync } from 'node:fs';

const REQUIRED_FRONTMATTER_FIELDS = ['id', 'title', 'date', 'status'];

// Sections that must be present (case-insensitive match)
// Note: "Requirements" or "Requirements Summary" both satisfy the requirements check
const REQUIRED_SECTIONS = [
  { pattern: /^##\s+Context/im, name: 'Context' },
  { pattern: /^##\s+Goal/im, name: 'Goal' },
  { pattern: /^##\s+Requirements/im, name: 'Requirements' }, // Matches "Requirements" or "Requirements Summary"
  { pattern: /^##\s+Task List/im, name: 'Task List' },
];

// Optional but checked sections
const OPTIONAL_SECTIONS = [
  { pattern: /^##\s+Acceptance Criteria/im, name: 'Acceptance Criteria' },
];

/**
 * Parse YAML frontmatter from markdown content.
 * Returns null if no frontmatter found.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const yamlContent = match[1];
  const fields = {};

  for (const line of yamlContent.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key) {
      // Allow empty values for some fields, just record presence
      fields[key] = value || '';
    }
  }

  return fields;
}

/**
 * Files that should be skipped by spec validation.
 * These are non-spec markdown files that live in the specs directory.
 */
const SKIP_PATTERNS = [
  /enforcement-report\.md$/,
  /investigation-report\.md$/,
  /requirements\.md$/,
];

/**
 * Non-spec document types identified by frontmatter `type` field.
 * These files get frontmatter validation only (no section checks).
 */
const NON_SPEC_TYPES = ['enforcement-report', 'requirements', 'investigation-report'];

/**
 * Validate a single spec file.
 * Returns object with errors and warnings arrays.
 */
function validateSpecFile(filePath) {
  // Skip non-spec files entirely based on filename
  if (SKIP_PATTERNS.some(pattern => pattern.test(filePath))) {
    return { errors: [], warnings: [] };
  }

  const errors = [];
  const warnings = [];

  if (!existsSync(filePath)) {
    errors.push(`File not found: ${filePath}`);
    return { errors, warnings };
  }

  const content = readFileSync(filePath, 'utf-8');

  // Validate frontmatter
  const frontmatter = parseFrontmatter(content);

  if (!frontmatter) {
    errors.push('missing YAML frontmatter');
    return { errors, warnings };
  }

  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (frontmatter[field] === undefined) {
      errors.push(`missing required frontmatter field '${field}'`);
    }
  }

  // Skip section validation for non-spec document types (e.g., enforcement reports, requirements)
  // These files live under .claude/specs/ but are not specs themselves.
  if (frontmatter.type && NON_SPEC_TYPES.includes(frontmatter.type)) {
    // Only frontmatter fields are validated for non-spec types; sections are not required
    return { errors, warnings };
  }

  // Validate status is a known value
  // Top-level specs use: draft, review, approved, implementing, complete, archived
  // Atomic specs use: pending, implementing, implemented, tested, verified
  const validStatuses = [
    'draft', 'review', 'approved', 'implementing', 'complete', 'archived', 'superseded',
    'pending', 'implemented', 'tested', 'verified'
  ];
  if (frontmatter.status && !validStatuses.includes(frontmatter.status)) {
    warnings.push(`unknown status '${frontmatter.status}' (expected one of: draft, review, approved, implementing, complete, archived [top-level] or pending, implementing, implemented, tested, verified [atomic])`);
  }

  // Validate required sections
  for (const section of REQUIRED_SECTIONS) {
    if (!section.pattern.test(content)) {
      errors.push(`missing required section '${section.name}'`);
    }
  }

  // Check optional sections and warn if missing (only for atomic specs, not master/workstream specs)
  // Master specs and workstream specs don't need Acceptance Criteria - they have workstreams instead
  const isAtomicSpec = filePath.includes('/atomic/') || frontmatter.id?.startsWith('as-');
  if (isAtomicSpec) {
    for (const section of OPTIONAL_SECTIONS) {
      if (!section.pattern.test(content)) {
        warnings.push(`missing optional section '${section.name}'`);
      }
    }
  }

  return { errors, warnings };
}

function main() {
  const args = process.argv.slice(2);

  // Strict mode is default; use --no-strict to disable
  // --strict is still accepted for backwards compatibility (no-op)
  const noStrict = args.includes('--no-strict');
  const strictMode = !noStrict;
  const filePaths = args.filter((arg) => arg !== '--strict' && arg !== '--no-strict');

  if (filePaths.length === 0) {
    console.error('Usage: spec-validate.mjs [--no-strict] <file1.md> [file2.md ...]');
    console.error('Error: No files provided.');
    process.exit(1);
  }

  let hasErrors = false;
  let hasWarnings = false;

  for (const filePath of filePaths) {
    const { errors, warnings } = validateSpecFile(filePath);

    if (errors.length > 0) {
      hasErrors = true;
      for (const error of errors) {
        console.error(`Error in ${filePath}: ${error}`);
      }
    }

    if (warnings.length > 0) {
      hasWarnings = true;
      for (const warning of warnings) {
        console.error(`Warning in ${filePath}: ${warning}`);
      }
    }
  }

  if (hasErrors) {
    process.exit(1);
  }

  if (strictMode && hasWarnings) {
    console.error('Strict mode: treating warnings as errors.');
    process.exit(1);
  }

  console.error(`Validated ${filePaths.length} spec file(s) successfully.`);
  process.exit(0);
}

main();
