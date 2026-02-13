#!/usr/bin/env node

/**
 * Warns on raw `throw new Error()` patterns in TypeScript files.
 *
 * Skips test files (__tests__/, *.test.ts, *.spec.ts).
 * Warning only — does not block (exit 0 always).
 *
 * Usage:
 *   node structured-error-validator.mjs <file.ts>
 *
 * Exit codes:
 *   0 - Always (warning only)
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { ERROR_MESSAGE_MAX_CHARS } from './lib/constants.mjs';

const RAW_ERROR_PATTERN = /throw\s+new\s+Error\s*\(/g;

const TEST_FILE_INDICATORS = [
  '__tests__/',
  '.test.ts',
  '.test.tsx',
  '.spec.ts',
  '.spec.tsx',
  '/test/',
  '/tests/',
  '/testing/',
];

function isTestFile(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return TEST_FILE_INDICATORS.some(indicator => normalized.includes(indicator));
}

function validateFile(filePath) {
  if (!existsSync(filePath)) return;
  if (isTestFile(filePath)) return;

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const warnings = [];

  for (let i = 0; i < lines.length; i++) {
    if (RAW_ERROR_PATTERN.test(lines[i])) {
      warnings.push({ line: i + 1, text: lines[i].trim() });
    }
    RAW_ERROR_PATTERN.lastIndex = 0;
  }

  if (warnings.length > 0) {
    console.error(`Warning: Raw 'throw new Error()' detected in ${filePath}`);
    console.error('  Consider using a typed error class with error_code, blame, and retry_safe fields.');
    for (const w of warnings) {
      console.error(`  Line ${w.line}: ${w.text.substring(0, ERROR_MESSAGE_MAX_CHARS)}`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: structured-error-validator.mjs <file.ts> [file2.ts ...]');
    process.exit(0);
  }

  for (const filePath of args) {
    validateFile(filePath);
  }

  // Always exit 0 — warning only, does not block
  process.exit(0);
}

main();
