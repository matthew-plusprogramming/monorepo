#!/usr/bin/env node

/**
 * Verifies evidence table is populated when an atomic spec transitions to 'implementing'.
 *
 * When an atomic spec has status: implementing, it should have a populated
 * Evidence Table (or Pre-Implementation Evidence Table) section with at least
 * one data row.
 *
 * Usage:
 *   node evidence-table-check.mjs <spec-file.md>
 *
 * Exit codes:
 *   0 - Always (warning only)
 */

import { readFileSync, existsSync } from 'node:fs';

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const fields = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key && value) fields[key] = value;
  }
  return fields;
}

function hasPopulatedEvidenceTable(content) {
  // Look for evidence table section headers
  const sectionPattern = /^##\s+(Pre-Implementation\s+)?Evidence\s+Table/im;
  const sectionMatch = content.match(sectionPattern);
  if (!sectionMatch) return false;

  // Find content after the section header
  const sectionStart = content.indexOf(sectionMatch[0]);
  const afterSection = content.slice(sectionStart + sectionMatch[0].length);

  // Find the next section (## heading) or end of file
  const nextSection = afterSection.search(/^##\s+/m);
  const sectionContent = nextSection === -1 ? afterSection : afterSection.slice(0, nextSection);

  // Check for at least one table data row (line with | that isn't header separator)
  const lines = sectionContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && !trimmed.match(/^\|[\s-|]+\|$/) && !trimmed.includes('Symbol') && !trimmed.includes('---')) {
      // Found a non-header, non-separator table row
      // Check it has actual content (not just empty cells)
      const cells = trimmed.split('|').filter(c => c.trim());
      if (cells.some(c => c.trim() && c.trim() !== '')) {
        return true;
      }
    }
  }

  return false;
}

function validateFile(filePath) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) return;

  // Only check specs in 'implementing' status
  if (frontmatter.status !== 'implementing') return;

  if (!hasPopulatedEvidenceTable(content)) {
    console.error(`Warning: ${filePath}`);
    console.error('  Atomic spec is in "implementing" status but has no populated Evidence Table.');
    console.error('  The Evidence-Before-Edit protocol requires evidence gathering before implementation.');
    console.error('  Add a "## Pre-Implementation Evidence Table" section with verified symbols.');
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: evidence-table-check.mjs <spec-file.md> [spec-file2.md ...]');
    process.exit(0);
  }

  for (const filePath of args) {
    validateFile(filePath);
  }

  // Always exit 0 — warning only
  process.exit(0);
}

main();
