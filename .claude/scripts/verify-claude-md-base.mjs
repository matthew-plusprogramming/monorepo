#!/usr/bin/env node

/**
 * Verifies CLAUDE.md base section matches canonical template.
 *
 * This script runs from the metaclaude-assistant repo and verifies
 * that a target repo's CLAUDE.md base section matches the canonical template.
 *
 * Usage:
 *   node verify-claude-md-base.mjs <path-to-target-repo>
 *
 * Examples:
 *   node .claude/scripts/verify-claude-md-base.mjs ../my-project
 *   node .claude/scripts/verify-claude-md-base.mjs /absolute/path/to/repo
 *
 * Exit codes:
 *   0 - Base sections match
 *   1 - Drift detected (diff printed to stderr)
 *   2 - File not found or invalid
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Find canonical template (relative to this script)
const TEMPLATE_PATH = resolve(__dirname, '../templates/claude-md-base.md');

// Pattern to identify end of base section
const PROJECT_SECTION_PATTERN = /^# Project:/m;
const BASE_END_PATTERN = /^---\s*$/m;

/**
 * Extract base section from CLAUDE.md content
 * Base section ends at the `---` line immediately before `# Project:`
 */
function extractBaseSection(content) {
  // Find where project section starts
  const projectMatch = content.match(PROJECT_SECTION_PATTERN);

  if (!projectMatch) {
    // No project section - entire file is base (or it's the template)
    return content.trim();
  }

  const projectIndex = projectMatch.index;
  const beforeProject = content.slice(0, projectIndex);

  // Find the last `---` before project section
  const lines = beforeProject.split('\n');
  let lastSeparatorIndex = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '---') {
      lastSeparatorIndex = i;
      break;
    }
  }

  if (lastSeparatorIndex === -1) {
    // No separator found, use everything before project
    return beforeProject.trim();
  }

  // Include the separator line
  return lines.slice(0, lastSeparatorIndex + 1).join('\n').trim();
}

/**
 * Compare two strings line by line and return diff
 */
function diffLines(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const diffs = [];

  const maxLen = Math.max(expectedLines.length, actualLines.length);

  for (let i = 0; i < maxLen; i++) {
    const exp = expectedLines[i] ?? '<missing>';
    const act = actualLines[i] ?? '<missing>';

    if (exp !== act) {
      diffs.push({
        line: i + 1,
        expected: exp,
        actual: act,
      });
    }
  }

  return diffs;
}

/**
 * Format diffs for display
 */
function formatDiff(diffs) {
  if (diffs.length === 0) return '';

  let output = `\n${'='.repeat(60)}\n`;
  output += `DRIFT DETECTED: ${diffs.length} line(s) differ\n`;
  output += `${'='.repeat(60)}\n\n`;

  for (const diff of diffs.slice(0, 20)) { // Limit to first 20 diffs
    output += `Line ${diff.line}:\n`;
    output += `  Expected: ${diff.expected.slice(0, 80)}${diff.expected.length > 80 ? '...' : ''}\n`;
    output += `  Actual:   ${diff.actual.slice(0, 80)}${diff.actual.length > 80 ? '...' : ''}\n\n`;
  }

  if (diffs.length > 20) {
    output += `... and ${diffs.length - 20} more differences\n`;
  }

  return output;
}

function main() {
  const args = process.argv.slice(2);
  const targetPath = args[0] ? resolve(args[0]) : process.cwd();
  const claudeMdPath = resolve(targetPath, 'CLAUDE.md');

  // Check template exists
  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`ERROR: Canonical template not found at: ${TEMPLATE_PATH}`);
    process.exit(2);
  }

  // Check target exists
  if (!existsSync(claudeMdPath)) {
    console.error(`ERROR: CLAUDE.md not found at: ${claudeMdPath}`);
    process.exit(2);
  }

  console.error(`Verifying: ${claudeMdPath}`);
  console.error(`Against:   ${TEMPLATE_PATH}`);
  console.error('');

  // Read files
  const templateContent = readFileSync(TEMPLATE_PATH, 'utf-8');
  const targetContent = readFileSync(claudeMdPath, 'utf-8');

  // Extract base sections
  const templateBase = extractBaseSection(templateContent);
  const targetBase = extractBaseSection(targetContent);

  // Compare
  const diffs = diffLines(templateBase, targetBase);

  if (diffs.length === 0) {
    console.error('✅ PASS: Base sections match');
    console.error(`   Template lines: ${templateBase.split('\n').length}`);
    console.error(`   Target lines:   ${targetBase.split('\n').length}`);
    process.exit(0);
  } else {
    console.error('❌ FAIL: Base section drift detected');
    console.error(formatDiff(diffs));
    process.exit(1);
  }
}

main();
