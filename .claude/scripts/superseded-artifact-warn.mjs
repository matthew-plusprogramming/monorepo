#!/usr/bin/env node

/**
 * Superseded Artifact Warning Hook
 *
 * Triggers on Read operations for spec files and checks if the artifact
 * has `status: superseded` in its frontmatter. If superseded, emits a
 * warning with the reference to the superseding artifact.
 *
 * Usage:
 *   echo '{"tool_input":{"file_path":"/path/to/spec.md"}}' | node superseded-artifact-warn.mjs
 *
 * This script is designed to be called via hook-wrapper.mjs for PostToolUse:Read hooks.
 *
 * Exit codes:
 *   0 - File is not superseded
 *   1 - No file provided or file not found
 *   2 - File is superseded (warning emitted)
 *
 * Implements: REQ-013, AC2.5 from sg-doc-traceability
 */

import { readFileSync, existsSync } from 'node:fs';

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
    // Skip comment lines
    if (line.trim().startsWith('#')) continue;

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key) {
      fields[key] = value;
    }
  }

  return fields;
}

/**
 * Check if a file is a superseded artifact and return warning info.
 * Returns null if not superseded or if file cannot be read.
 */
function checkSuperseded(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  const content = readFileSync(filePath, 'utf-8');
  const frontmatter = parseFrontmatter(content);

  if (!frontmatter) {
    return null;
  }

  if (frontmatter.status !== 'superseded') {
    return null;
  }

  // Artifact is superseded - gather info for warning
  return {
    supersededBy: frontmatter.superseded_by || 'unknown',
    supersessionDate: frontmatter.supersession_date || 'unknown date',
    supersessionReason: frontmatter.supersession_reason || null
  };
}

/**
 * Format the warning message for a superseded artifact.
 */
function formatWarning(filePath, info) {
  const lines = [
    '========================================',
    'WARNING: SUPERSEDED ARTIFACT',
    '========================================',
    `File: ${filePath}`,
    `This spec was superseded by ${info.supersededBy} on ${info.supersessionDate}.`,
    'Proceed with caution - this spec may contain outdated information.'
  ];

  if (info.supersessionReason) {
    lines.push(`Reason: ${info.supersessionReason}`);
  }

  lines.push('========================================');

  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Error: No file provided.');
    process.exit(1);
  }

  const filePath = args[0];

  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  // Check if the file is a superseded artifact
  const supersededInfo = checkSuperseded(filePath);

  if (supersededInfo) {
    // Emit warning to stdout (hook-wrapper will display this)
    console.error(formatWarning(filePath, supersededInfo));
    process.exit(2);
  }

  // File exists and is not superseded
  process.exit(0);
}

main();
