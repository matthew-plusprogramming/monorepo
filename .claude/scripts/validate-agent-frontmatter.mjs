#!/usr/bin/env node

/**
 * Validates YAML frontmatter in agent .md files.
 *
 * Required fields: name, description, tools, model
 *
 * Usage:
 *   node validate-agent-frontmatter.mjs <file1.md> [file2.md ...]
 *
 * The script accepts file paths as arguments (passed via hook-wrapper.mjs).
 *
 * Exit codes:
 *   0 - All files pass validation
 *   1 - One or more files failed validation
 */

import { readFileSync, existsSync } from 'node:fs';

const REQUIRED_FIELDS = ['name', 'description', 'tools', 'model'];

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

    if (key && value) {
      fields[key] = value;
    }
  }

  return fields;
}

/**
 * Validate a single agent file.
 * Returns array of error messages (empty if valid).
 */
function validateAgentFile(filePath) {
  const errors = [];

  if (!existsSync(filePath)) {
    errors.push(`File not found: ${filePath}`);
    return errors;
  }

  const content = readFileSync(filePath, 'utf-8');
  const frontmatter = parseFrontmatter(content);

  if (!frontmatter) {
    // No frontmatter is acceptable - just skip validation
    return errors;
  }

  for (const field of REQUIRED_FIELDS) {
    if (!frontmatter[field]) {
      errors.push(`missing required field '${field}'`);
    }
  }

  return errors;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: validate-agent-frontmatter.mjs <file1.md> [file2.md ...]');
    console.log('No files provided, nothing to validate.');
    process.exit(0);
  }

  let hasErrors = false;

  for (const filePath of args) {
    const errors = validateAgentFile(filePath);

    if (errors.length > 0) {
      hasErrors = true;
      for (const error of errors) {
        console.error(`Error in ${filePath}: ${error}`);
      }
    }
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log(`Validated ${args.length} agent file(s) successfully.`);
  process.exit(0);
}

main();
