#!/usr/bin/env node

/**
 * PreToolUse Write Protection Hook for Enforcement Files
 *
 * Blocks agent writes to gate-override.json and gate-enforcement-disabled.
 * Only human terminal writes are permitted for these files.
 *
 * CRITICAL: This hook does NOT check the kill switch (AC-3.4).
 * Write protection remains active regardless of gate-enforcement-disabled state.
 * This prevents agents from self-bypassing enforcement.
 *
 * Invocation: Receives stdin JSON from Claude Code PreToolUse hook system.
 * Input format: { session_id: string, tool_name: string, tool_input: { file_path: string } }
 *
 * Exit codes:
 *   0 - Allow write (not a protected file)
 *   2 - Block write (protected enforcement file)
 *
 * Implements: REQ-012
 * Spec: sg-coercive-gate-enforcement
 */

import { resolve, basename, sep } from 'node:path';
import { readStdin } from './lib/hook-utils.mjs';

/**
 * Protected file basenames that agents must not write to.
 * @type {string[]}
 */
const PROTECTED_FILENAMES = [
  'gate-override.json',
  'gate-enforcement-disabled',
];

async function main() {
  try {
    // Read and parse stdin
    const stdinContent = await readStdin();

    if (!stdinContent.trim()) {
      process.exit(0);
    }

    let inputData;
    try {
      inputData = JSON.parse(stdinContent);
    } catch {
      process.exit(0); // Malformed input -- fail-open
    }

    const toolInput = inputData.tool_input || {};
    const filePath = toolInput.file_path;

    if (!filePath || typeof filePath !== 'string') {
      process.exit(0); // No file path -- fail-open
    }

    // Check if the target file is a protected enforcement file
    // Security fix H1: normalize path to prevent traversal bypasses
    const normalizedPath = resolve(filePath);
    const fileName = basename(normalizedPath);

    for (const protectedName of PROTECTED_FILENAMES) {
      if (fileName === protectedName &&
          normalizedPath.includes(sep + 'coordination' + sep)) {
        // AC-3.1, AC-3.2: Block the write
        process.stderr.write('\n');
        process.stderr.write('========================================\n');
        process.stderr.write('BLOCKED: Protected Enforcement File\n');
        process.stderr.write('========================================\n');
        process.stderr.write('\n');
        process.stderr.write(`Cannot write to '${protectedName}' -- this file is protected.\n`);
        process.stderr.write('Only human terminal writes are permitted for enforcement files.\n');
        process.stderr.write('\n');
        process.stderr.write('========================================\n');
        process.stderr.write('\n');
        process.exit(2);
      }
    }

    // AC-3.3: Not a protected file -- allow
    process.exit(0);
  } catch (err) {
    // Fail-open on any error
    process.stderr.write(`Error in workflow-file-protection hook: ${err.message}\n`);
    process.exit(0);
  }
}

main();
