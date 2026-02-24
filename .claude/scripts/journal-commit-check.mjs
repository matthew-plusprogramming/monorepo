#!/usr/bin/env node

/**
 * Journal Commit Check Hook
 *
 * PostToolUse hook that warns when git commit runs while a required
 * journal entry has not been created.
 *
 * This hook:
 * 1. Reads the Bash command from stdin (JSON format from Claude Code hooks)
 * 2. Checks if the command contains 'git commit'
 * 3. If so, reads .claude/context/session.json
 * 4. If journal_required is true and journal_created is not true, prints
 *    warning to stderr and exits with code 2
 *
 * Exit codes:
 *   0 - No issues (non-commit command, or journal not required/already created)
 *   2 - Warning: journal entry required but not created (stderr shown to Claude)
 *
 * Usage:
 *   Triggered automatically as a PostToolUse hook for Bash commands
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Find the .claude directory by walking up from script location.
 */
function findClaudeDir() {
  let currentDir = dirname(resolve(import.meta.url.replace('file://', '')));
  const root = '/';

  while (currentDir !== root) {
    const claudeDir = join(currentDir, '.claude');
    if (existsSync(claudeDir)) {
      return claudeDir;
    }
    if (currentDir.endsWith('.claude')) {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return join(process.cwd(), '.claude');
}

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
 */
function isGitCommitCommand(command) {
  if (!command || typeof command !== 'string') {
    return false;
  }

  // Match various forms of git commit:
  // - git commit
  // - git commit -m "..."
  // - git commit --amend
  // etc.
  return /\bgit\s+commit\b/i.test(command);
}

/**
 * Load session.json and check journal status.
 */
function checkJournalStatus(claudeDir) {
  const sessionPath = join(claudeDir, 'context', 'session.json');

  if (!existsSync(sessionPath)) {
    // No session file, nothing to check
    return { shouldWarn: false };
  }

  try {
    const content = readFileSync(sessionPath, 'utf-8');
    const session = JSON.parse(content);

    // Check if journal is required but not created
    const phaseCheckpoint = session.phase_checkpoint;
    if (!phaseCheckpoint) {
      return { shouldWarn: false };
    }

    if (phaseCheckpoint.journal_required === true &&
        phaseCheckpoint.journal_created !== true) {
      return {
        shouldWarn: true,
        workflow: session.active_work?.workflow || 'unknown',
        phase: phaseCheckpoint.phase || 'unknown'
      };
    }

    return { shouldWarn: false };
  } catch (err) {
    // Error reading/parsing session, don't block
    return { shouldWarn: false };
  }
}

async function main() {
  try {
    // Read stdin to get the hook input
    const stdinContent = await readStdin();

    if (!stdinContent.trim()) {
      // No input — exit silently
      process.exit(0);
    }

    let inputData;
    try {
      inputData = JSON.parse(stdinContent);
    } catch (e) {
      // Invalid JSON — exit silently
      process.exit(0);
    }

    // Extract command from tool_input
    const toolInput = inputData.tool_input || {};
    const command = toolInput.command;

    // Check if this is a git commit command
    if (!isGitCommitCommand(command)) {
      // Not a git commit, nothing to check
      process.exit(0);
    }

    // Find .claude directory and check journal status
    const claudeDir = findClaudeDir();
    const status = checkJournalStatus(claudeDir);

    if (status.shouldWarn) {
      // Print warning to stderr
      process.stderr.write('\n');
      process.stderr.write('========================================\n');
      process.stderr.write('WARNING: Journal Entry Not Created\n');
      process.stderr.write('========================================\n');
      process.stderr.write('\n');
      process.stderr.write('A journal entry is required for this workflow but has not been created.\n');
      process.stderr.write('\n');
      process.stderr.write(`Workflow: ${status.workflow}\n`);
      process.stderr.write(`Current phase: ${status.phase}\n`);
      process.stderr.write('\n');
      process.stderr.write('Please create a journal entry before committing:\n');
      process.stderr.write('  1. Create journal entry in .claude/journal/entries/\n');
      process.stderr.write('  2. Run: node .claude/scripts/session-checkpoint.mjs journal-created <path>\n');
      process.stderr.write('\n');
      process.stderr.write('========================================\n');
      process.stderr.write('\n');

      // Exit 2 so PostToolUse shows stderr to Claude as a warning
      process.exit(2);
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error in journal-commit-check hook: ${err.message}\n`);
    // Don't block on hook errors — exit cleanly
    process.exit(0);
  }
}

main();
