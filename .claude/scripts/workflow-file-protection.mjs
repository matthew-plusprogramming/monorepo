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
 * Implements: REQ-012, AC-14.9 (deployment trust root protection)
 * Spec: sg-coercive-gate-enforcement, sg-deployment-verification-gaps
 */

import { resolve, basename, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { readStdin } from './lib/hook-utils.mjs';

/**
 * Protected file basenames that agents must not write to.
 * @type {string[]}
 */
const PROTECTED_FILENAMES = [
  'gate-override.json',
  'gate-enforcement-disabled',
  'session.json',
  // AC-14.9.a: Deployment intervention audit log (trust root)
  'deployment-interventions.log',
  // AC-14.9.b: Chain verifier script (trust root)
  'verify-deployment-audit-chain.mjs',
  // sg-convergence-recorder-tolerance T-10 / AC-17 / AC-23:
  // Diagnostic log for convergence-pass-recorder. Treated as FULL_BLOCK so
  // Claude agent Write/Edit tool calls cannot tamper with it. Direct
  // fs.appendFileSync from in-repo Node scripts is intentionally outside
  // this hook's vantage (it observes only Claude tool-call stdin JSON).
  'session.log',
];

/**
 * Protected path prefixes for directory-level protection.
 * Files whose .claude/-relative path starts with any prefix are protected.
 * AC-14.9.c: deployment-manifests/ prefix match (~5 lines, no glob dependency).
 * @type {string[]}
 */
const PROTECTED_PATH_PREFIXES = [
  'deployment-manifests/',
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
  // Check if command references any protected filename (exact match)
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

  // AC-14.9.c: Check prefix-based directory protection for Bash commands
  for (const prefix of PROTECTED_PATH_PREFIXES) {
    if (!command.includes(prefix)) {
      continue;
    }
    for (const pattern of BASH_WRITE_PATTERNS) {
      if (pattern.test(command)) {
        return `.claude/${prefix}*`;
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
  } else if (protectedName === 'session.log') {
    // sg-convergence-recorder-tolerance T-10 / AC-17
    process.stderr.write(`Cannot write to '${protectedName}' via ${toolName} -- this file is protected.\n`);
    process.stderr.write('session.log is the diagnostic log for convergence-pass-recorder.mjs (FULL_BLOCK).\n');
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
    // M3 fix: resolve symlinks before prefix comparison to prevent symlink-based bypass.
    // Falls back to resolve() if file doesn't exist yet (realpathSync requires existing path).
    let normalizedPath;
    try {
      normalizedPath = realpathSync(resolve(filePath));
    } catch {
      normalizedPath = resolve(filePath);
    }
    const fileName = basename(normalizedPath);

    for (const protectedName of PROTECTED_FILENAMES) {
      // Check directory context: coordination/ for enforcement files, context/ for session.json
      // AC-14.9.a: audit/ for deployment-interventions.log
      // AC-14.9.b: scripts/ for verify-deployment-audit-chain.mjs
      const isCoordinationFile = normalizedPath.includes(sep + 'coordination' + sep);
      const isContextFile = normalizedPath.includes(sep + 'context' + sep);
      const isAuditFile = normalizedPath.includes(sep + 'audit' + sep);
      const isScriptsFile = normalizedPath.includes(sep + 'scripts' + sep);

      let isProtectedPath = false;
      if (protectedName === 'session.json') {
        isProtectedPath = isContextFile;
      } else if (protectedName === 'session.log') {
        // sg-convergence-recorder-tolerance T-10 / AC-17:
        // session.log lives alongside session.json under .claude/context/
        isProtectedPath = isContextFile;
      } else if (protectedName === 'deployment-interventions.log') {
        isProtectedPath = isAuditFile;
      } else if (protectedName === 'verify-deployment-audit-chain.mjs') {
        isProtectedPath = isScriptsFile;
      } else {
        isProtectedPath = isCoordinationFile;
      }

      if (fileName === protectedName && isProtectedPath) {
        // AC-3.1, AC-3.2, AC-14.9: Block the write
        blockProtectedFileWrite(protectedName, 'Write');
      }
    }

    // AC-14.9.c: Prefix-based directory protection for deployment-manifests/
    for (const prefix of PROTECTED_PATH_PREFIXES) {
      // Extract .claude/-relative path from normalized absolute path
      const claudeIdx = normalizedPath.indexOf(sep + '.claude' + sep);
      if (claudeIdx >= 0) {
        const relativePath = normalizedPath.substring(claudeIdx + sep.length + '.claude'.length + sep.length);
        if (relativePath.startsWith(prefix)) {
          blockProtectedFileWrite(`.claude/${prefix}*`, 'Write');
        }
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
