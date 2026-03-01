#!/usr/bin/env node

/**
 * Trace Commit Staleness PostToolUse Hook
 *
 * PostToolUse hook on Bash that blocks git commits when staged files
 * belong to modules with stale traces (source files modified after
 * trace was last generated).
 *
 * Implements: REQ-AT-020, REQ-AT-021
 * Spec: as-009-trace-commit-staleness
 *
 * Exit codes:
 *   0 - No issues (non-commit command, no stale traces, no trace system)
 *   2 - Block: stale traces found for committed files (stderr lists modules)
 *
 * Usage:
 *   Triggered automatically as a PostToolUse hook for Bash commands.
 *   Reads stdin JSON: { tool_input: { command: "..." } }
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  loadTraceConfig,
  fileToModule,
  isTraceStale,
  resolveProjectRoot,
  TRACE_CONFIG_PATH,
} from './lib/trace-utils.mjs';

/**
 * Read all stdin as a string.
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Check if a command string contains a git commit command.
 *
 * Matches: git commit, git commit -m "...", git commit --amend, etc.
 * Does NOT match: git commit-graph, git committed (no word boundary match).
 *
 * @param {string} command - Bash command string
 * @returns {boolean} True if the command is a git commit
 */
function isGitCommitCommand(command) {
  if (!command || typeof command !== 'string') {
    return false;
  }

  // AC-8.3: Match git commit with word boundary to avoid false positives
  return /\bgit\s+commit\b/i.test(command);
}

/**
 * Get the list of staged files from a git commit.
 *
 * Uses git diff --cached --name-only to enumerate files that were staged
 * at the time of the commit. For PostToolUse hooks, the commit has already
 * happened, so we look at the most recent commit's files.
 *
 * @param {string} projectRoot - Project root directory
 * @returns {string[]} Array of relative file paths that were committed
 */
function getStagedFiles(projectRoot) {
  try {
    // The commit has already completed by the time PostToolUse fires.
    // Use git diff-tree to get files from the most recent commit.
    const output = execSync('git diff-tree --no-commit-id --name-only -r HEAD', {
      encoding: 'utf-8',
      cwd: projectRoot,
      timeout: 10_000,
    });

    return output
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    // If git diff-tree fails (e.g., initial commit with no parent),
    // try listing all files in HEAD
    try {
      const output = execSync('git diff-tree --no-commit-id --name-only -r --root HEAD', {
        encoding: 'utf-8',
        cwd: projectRoot,
        timeout: 10_000,
      });

      return output
        .trim()
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/**
 * Main hook logic.
 *
 * Flow:
 * 1. Parse stdin JSON for the Bash command
 * 2. If not a git commit -> exit 0 (AC-8.3)
 * 3. If no trace system configured -> exit 0 (AC-8.5)
 * 4. Get committed files, map to modules
 * 5. Check each module's trace staleness
 * 6. If stale -> exit 2 with module list (AC-8.2)
 * 7. If fresh -> exit 0 (AC-8.1)
 */
async function main() {
  try {
    // Step 1: Read and parse stdin
    const stdinContent = await readStdin();

    if (!stdinContent.trim()) {
      process.exit(0);
    }

    let inputData;
    try {
      inputData = JSON.parse(stdinContent);
    } catch {
      // Malformed input -- fail open (Security: input validation)
      process.exit(0);
    }

    // Extract command from tool_input
    const toolInput = inputData.tool_input || {};
    const command = toolInput.command;

    // Step 2: AC-8.3 -- Non-git-commit commands exit immediately
    if (!isGitCommitCommand(command)) {
      process.exit(0);
    }

    // Step 3: Resolve project root and check if trace system exists
    const projectRoot = resolveProjectRoot();
    const configPath = join(projectRoot, TRACE_CONFIG_PATH);

    // AC-8.5: If no trace config exists, exit 0 (no trace system configured)
    if (!existsSync(configPath)) {
      process.exit(0);
    }

    // Also check if .claude/traces/ directory exists
    const tracesDir = join(projectRoot, '.claude', 'traces');
    if (!existsSync(tracesDir)) {
      process.exit(0);
    }

    // Step 4: Load config and get committed files
    let config;
    try {
      config = loadTraceConfig(projectRoot);
    } catch {
      // Config exists but is malformed -- fail open to avoid blocking work
      process.exit(0);
    }

    const committedFiles = getStagedFiles(projectRoot);

    if (committedFiles.length === 0) {
      // No files in commit (e.g., empty commit or error reading)
      process.exit(0);
    }

    // Step 5: Map files to modules and check staleness
    const staleModules = new Map(); // moduleId -> moduleName
    const checkedModules = new Set(); // moduleIds already evaluated (stale or fresh)

    for (const filePath of committedFiles) {
      const mod = fileToModule(filePath, config);

      // AC-8.4: Untraced files do not cause staleness errors
      if (!mod) {
        continue;
      }

      // Skip modules we've already checked (both stale and fresh)
      if (checkedModules.has(mod.id)) {
        continue;
      }
      checkedModules.add(mod.id);

      // Check if this module's trace is stale
      if (isTraceStale(mod.id, config, projectRoot)) {
        staleModules.set(mod.id, mod.name);
      }
    }

    // Step 6/7: Report results
    if (staleModules.size === 0) {
      // AC-8.1: All traces fresh, allow commit
      process.exit(0);
    }

    // AC-8.2: Stale traces found -- block with exit code 2
    process.stderr.write('\n');
    process.stderr.write('========================================\n');
    process.stderr.write('BLOCKED: Stale Architecture Traces\n');
    process.stderr.write('========================================\n');
    process.stderr.write('\n');
    process.stderr.write('The following modules have stale traces\n');
    process.stderr.write('(source files modified after trace generation):\n');
    process.stderr.write('\n');

    for (const [moduleId, moduleName] of staleModules) {
      process.stderr.write(`  - ${moduleName} (${moduleId})\n`);
    }

    process.stderr.write('\n');
    process.stderr.write('Regenerate traces before committing:\n');
    process.stderr.write('\n');

    for (const [moduleId] of staleModules) {
      process.stderr.write(`  node .claude/scripts/trace-generate.mjs ${moduleId}\n`);
    }

    process.stderr.write('\n');
    process.stderr.write('Or regenerate all traces:\n');
    process.stderr.write('  node .claude/scripts/trace-generate.mjs\n');
    process.stderr.write('\n');
    process.stderr.write('========================================\n');
    process.stderr.write('\n');

    process.exit(2);
  } catch (err) {
    // Don't block on hook errors -- fail open
    process.stderr.write(`Error in trace-commit-staleness hook: ${err.message}\n`);
    process.exit(0);
  }
}

main();
