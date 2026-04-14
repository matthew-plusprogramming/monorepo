#!/usr/bin/env node

/**
 * PreToolUse Write Protection Hook for Enforcement Files
 *
 * Blocks agent writes to gate-override.json, gate-enforcement-disabled, and session.json.
 * Only human terminal writes are permitted for these files.
 *
 * Matches both Write and Bash tools:
 *   - Write tool: checks tool_input.file_path directly
 *   - Bash tool: checks tool_input.command for write-like operations (cp, mv, tee, >)
 *     targeting protected filenames (defense in depth, not exhaustive)
 *
 * CRITICAL: This hook does NOT check the kill switch (AC-3.4).
 * Write protection remains active regardless of gate-enforcement-disabled state.
 * This prevents agents from self-bypassing enforcement.
 *
 * Invocation: Receives stdin JSON from Claude Code PreToolUse hook system.
 * Input format (Write): { session_id: string, tool_name: string, tool_input: { file_path: string } }
 * Input format (Bash):  { session_id: string, tool_name: string, tool_input: { command: string } }
 *
 * Exit codes:
 *   0 - Allow (not a protected file / no write to protected file detected)
 *   2 - Block (write to protected enforcement file detected)
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
  'session.json',
];

/**
 * Shell command patterns that indicate a write operation.
 * Used for defense-in-depth Bash tool checking (not exhaustive).
 * @type {RegExp[]}
 */
const BASH_WRITE_PATTERNS = [
  /\bcp\b/,
  /\bmv\b/,
  /\btee\b/,
  /\bdd\b/,
  /\binstall\b/,
  /\brsync\b/,
  /\bln\b/,
  />/,              // redirect (covers > and >>)
  /\bsed\b.*-i/,   // in-place sed
  /\bchmod\b/,
  /\bchown\b/,
  /\brm\b/,
  /\bunlink\b/,
  /\btouch\b/,
  /\bmkdir\b/,      // could create parent dirs for protected files
  /\bcat\b.*>/,     // cat with output redirect
  /\becho\b.*>/,    // echo with output redirect
  /\bprintf\b.*>/,  // printf with output redirect
  /\bnode\b.*-e\b/, // node -e can write files via fs module
  /\bpython\b/,     // python can write files
];

/**
 * Check if a Bash command contains a write-like operation targeting a protected file.
 * This is defense-in-depth string matching, not a full shell parser.
 *
 * @param {string} command - The shell command string
 * @returns {string|null} The protected filename found, or null if safe
 */
function detectBashWriteToProtectedFile(command) {
  // Check if command references any protected filename
  for (const protectedName of PROTECTED_FILENAMES) {
    if (!command.includes(protectedName)) {
      continue;
    }

    // Command mentions a protected file -- check for write-like operations
    for (const pattern of BASH_WRITE_PATTERNS) {
      if (pattern.test(command)) {
        return protectedName;
      }
    }
  }

  return null;
}

/**
 * Block a tool invocation with a descriptive error message.
 *
 * @param {string} protectedName - The protected file that was targeted
 * @param {string} toolName - The tool that was used (Write, Bash, etc.)
 */
function blockProtectedFileWrite(protectedName, toolName) {
  process.stderr.write('\n');
  process.stderr.write('========================================\n');
  process.stderr.write('BLOCKED: Protected Enforcement File\n');
  process.stderr.write('========================================\n');
  process.stderr.write('\n');
  if (protectedName === 'session.json') {
    process.stderr.write(`Cannot write to '${protectedName}' via ${toolName} -- this file is protected.\n`);
    process.stderr.write('All session.json writes must go through session-checkpoint.mjs CLI.\n');
  } else {
    process.stderr.write(`Cannot write to '${protectedName}' via ${toolName} -- this file is protected.\n`);
    process.stderr.write('Only human terminal writes are permitted for enforcement files.\n');
  }
  process.stderr.write('\n');
  process.stderr.write('========================================\n');
  process.stderr.write('\n');
  process.exit(2);
}

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

    const toolName = inputData.tool_name || '';
    const toolInput = inputData.tool_input || {};

    // --- Bash tool handling (defense in depth) ---
    if (toolName === 'Bash') {
      const command = toolInput.command;
      if (!command || typeof command !== 'string') {
        process.exit(0); // No command -- fail-open
      }

      const detectedFile = detectBashWriteToProtectedFile(command);
      if (detectedFile) {
        blockProtectedFileWrite(detectedFile, 'Bash');
      }

      // No protected file write detected in Bash command
      process.exit(0);
    }

    // --- Write tool handling (original logic) ---
    const filePath = toolInput.file_path;

    if (!filePath || typeof filePath !== 'string') {
      process.exit(0); // No file path -- fail-open
    }

    // Check if the target file is a protected enforcement file
    // Security fix H1: normalize path to prevent traversal bypasses
    const normalizedPath = resolve(filePath);
    const fileName = basename(normalizedPath);

    for (const protectedName of PROTECTED_FILENAMES) {
      // Check directory context: coordination/ for enforcement files, context/ for session.json
      const isCoordinationFile = normalizedPath.includes(sep + 'coordination' + sep);
      const isContextFile = normalizedPath.includes(sep + 'context' + sep);
      const isProtectedPath = protectedName === 'session.json' ? isContextFile : isCoordinationFile;

      if (fileName === protectedName && isProtectedPath) {
        // AC-3.1, AC-3.2: Block the write
        blockProtectedFileWrite(protectedName, 'Write');
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
