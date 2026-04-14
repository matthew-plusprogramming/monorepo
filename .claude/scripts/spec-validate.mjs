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
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSpecFilePaths } from './lib/spec-utils.mjs';

const REQUIRED_FRONTMATTER_FIELDS = ['id', 'title', 'date', 'status'];

// Import VALID_E2E_SKIP_RATIONALES from workflow-dag.mjs for defense-in-depth
// Falls back to inline constant if import fails (fail-open)
let VALID_E2E_SKIP_RATIONALES;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const dagModule = await import(join(__dirname, 'lib', 'workflow-dag.mjs'));
  VALID_E2E_SKIP_RATIONALES = dagModule.VALID_E2E_SKIP_RATIONALES;
} catch {
  VALID_E2E_SKIP_RATIONALES = ['pure-refactor', 'test-infra', 'type-only', 'docs-only'];
}

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
      // Recognize YAML boolean literals (true/false without quotes -> boolean type)
      // AC-7.4 approach (a): defense-in-depth boolean recognition
      if (value === 'true') {
        fields[key] = true;
      } else if (value === 'false') {
        fields[key] = false;
      } else {
        // Allow empty values for some fields, just record presence
        fields[key] = value || '';
      }
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
 * Check if a file path is under the .claude/specs/ directory.
 * Used to determine validation strictness -- files outside spec directories
 * get lighter validation (frontmatter + env check only).
 */
function isUnderSpecsDirectory(filePath) {
  const normalized = resolve(filePath);
  return normalized.includes('.claude/specs/') || normalized.includes('.claude' + '/specs/');
}

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

  // Full structural validation only for files under .claude/specs/
  // Files outside (e.g., direct CLI invocation on arbitrary spec files)
  // get frontmatter + env check only
  const fullValidation = isUnderSpecsDirectory(filePath);

  if (fullValidation) {
    for (const field of REQUIRED_FRONTMATTER_FIELDS) {
      if (frontmatter[field] === undefined) {
        errors.push(`missing required frontmatter field '${field}'`);
      }
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

  // Validate e2e_skip fields (AC-7.3, AC-7.4, AC-7.5)
  if (frontmatter.e2e_skip !== undefined) {
    // AC-7.4: Strict boolean type enforcement
    if (typeof frontmatter.e2e_skip !== 'boolean') {
      errors.push(`e2e_skip must be a boolean (true or false), got '${frontmatter.e2e_skip}'`);
    }

    // AC-7.3: When e2e_skip is true, e2e_skip_rationale is required (EC-1)
    if (frontmatter.e2e_skip === true) {
      if (!frontmatter.e2e_skip_rationale) {
        errors.push('e2e_skip: true requires e2e_skip_rationale (one of: pure-refactor, test-infra, type-only, docs-only)');
      } else if (!VALID_E2E_SKIP_RATIONALES.includes(frontmatter.e2e_skip_rationale)) {
        errors.push(`e2e_skip_rationale '${frontmatter.e2e_skip_rationale}' is not valid (must be one of: ${VALID_E2E_SKIP_RATIONALES.join(', ')})`);
      }
    }
  }

  // AC-7.5: Warn on orphaned e2e_skip_rationale (rationale present without e2e_skip: true)
  if (frontmatter.e2e_skip_rationale && frontmatter.e2e_skip !== true) {
    warnings.push('e2e_skip_rationale is present but e2e_skip is not true -- rationale has no effect');
  }

  // Validate e2e_skip_rationale even when standalone (if it's an invalid value)
  // Guard: only when e2e_skip !== true, since the e2e_skip === true path (lines 164-169) already validates rationale
  if (frontmatter.e2e_skip !== true && frontmatter.e2e_skip_rationale && typeof frontmatter.e2e_skip_rationale === 'string' && frontmatter.e2e_skip_rationale !== '') {
    if (!VALID_E2E_SKIP_RATIONALES.includes(frontmatter.e2e_skip_rationale)) {
      errors.push(`e2e_skip_rationale '${frontmatter.e2e_skip_rationale}' is not valid (must be one of: ${VALID_E2E_SKIP_RATIONALES.join(', ')})`);
    }
  }

  // Validate required sections (only for files under .claude/specs/)
  if (fullValidation) {
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
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Env-dependent AC enforcement (AC-1.6, sg-pipeline-integration-gaps)
// ---------------------------------------------------------------------------

/** Patterns that indicate environment-dependent code */
const ENV_ACCESS_PATTERNS = [
  /process\.env\b/,
  /NODE_ENV/,
  /import\.meta\.env\b/,
];

/** Keywords in ACs that indicate coverage of default/unset env case */
const DEFAULT_ENV_KEYWORDS = [
  /\bunset\b/i,
  /\bdefault\b/i,
  /\bnot\s+set\b/i,
  /\babsent\b/i,
  /\bmissing\b/i,
  /\bclean\s+environment\b/i,
  /\bundefined\b/i,
];

// extractSpecFilePaths imported from ./lib/spec-utils.mjs (was extractFilePathsFromSpec)

/**
 * Check if a file contains env-dependent code patterns.
 */
function fileHasEnvAccess(filePath) {
  try {
    if (!existsSync(filePath)) return false; // EC-14: silently skip missing files
    const content = readFileSync(filePath, 'utf-8');
    return ENV_ACCESS_PATTERNS.some(pattern => pattern.test(content));
  } catch {
    return false; // Silently skip unreadable files
  }
}

/**
 * Check if any acceptance criterion covers the default/unset env case.
 */
function hasDefaultEnvAC(content) {
  // Extract acceptance criteria section only -- scope keyword search to AC section
  const acMatch = content.match(/## Acceptance Criteria([\s\S]*?)(?=\n## |$)/i);
  const acSection = acMatch ? acMatch[1] : content; // fallback to full content if no AC section
  return DEFAULT_ENV_KEYWORDS.some(keyword => keyword.test(acSection));
}

/**
 * Run env-dependent AC enforcement check (AC-1.6).
 * Returns advisory warnings (never errors).
 *
 * @param {string} filePath - Path to the spec file
 * @param {string} content - Spec file content
 * @returns {string[]} Advisory warnings
 */
function checkEnvDependentACs(filePath, content) {
  const advisories = [];

  // Extract referenced file paths from spec
  const specFilePaths = extractSpecFilePaths(content);
  if (specFilePaths.length === 0) return advisories;

  // Resolve file paths relative to spec directory or cwd
  const specDir = dirname(filePath);
  let hasEnvDependentCode = false;

  for (const relPath of specFilePaths) {
    // Try resolving relative to cwd (most common for spec file paths like src/...)
    const cwdResolved = resolve(process.cwd(), relPath);
    // Also try relative to spec directory
    const specDirResolved = resolve(specDir, relPath);

    if (fileHasEnvAccess(cwdResolved) || fileHasEnvAccess(specDirResolved)) {
      hasEnvDependentCode = true;
      break;
    }
  }

  if (!hasEnvDependentCode) return advisories;

  // Check if any AC covers the default/unset env case
  if (!hasDefaultEnvAC(content)) {
    advisories.push(
      'Spec references env-dependent code but has no AC for default/unset environment'
    );
  }

  return advisories;
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

    // Env-dependent AC enforcement (AC-1.6) -- advisory only, never blocking
    // Runs after main validation to avoid affecting exit code
    try {
      const content = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
      const envAdvisories = checkEnvDependentACs(filePath, content);
      for (const advisory of envAdvisories) {
        console.error(`Advisory in ${filePath}: ${advisory}`);
      }
    } catch {
      // Env check failure is silently ignored -- advisory only
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
