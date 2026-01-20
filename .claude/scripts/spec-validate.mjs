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
 * The script accepts file paths as arguments (from $CLAUDE_FILE_PATHS).
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
 * Validate a single spec file.
 * Returns object with errors and warnings arrays.
 */
function validateSpecFile(filePath) {
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

  // Validate status is a known value
  const validStatuses = ['draft', 'review', 'approved', 'implementing', 'complete', 'archived'];
  if (frontmatter.status && !validStatuses.includes(frontmatter.status)) {
    warnings.push(`unknown status '${frontmatter.status}' (expected one of: ${validStatuses.join(', ')})`);
  }

  // Validate required sections
  for (const section of REQUIRED_SECTIONS) {
    if (!section.pattern.test(content)) {
      errors.push(`missing required section '${section.name}'`);
    }
  }

  // Check optional sections and warn if missing
  for (const section of OPTIONAL_SECTIONS) {
    if (!section.pattern.test(content)) {
      warnings.push(`missing optional section '${section.name}'`);
    }
  }

  return { errors, warnings };
}

function main() {
  const args = process.argv.slice(2);

  // Check for --strict flag
  const strictMode = args.includes('--strict');
  const filePaths = args.filter((arg) => arg !== '--strict');

  if (filePaths.length === 0) {
    console.log('Usage: spec-validate.mjs [--strict] <file1.md> [file2.md ...]');
    console.log('No files provided, nothing to validate.');
    process.exit(0);
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
        console.warn(`Warning in ${filePath}: ${warning}`);
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

  console.log(`Validated ${filePaths.length} spec file(s) successfully.`);
  process.exit(0);
}

main();
