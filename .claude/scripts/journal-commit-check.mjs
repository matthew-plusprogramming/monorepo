#!/usr/bin/env node

/**
 * Journal Commit Check Hook
 *
 * PostToolUse hook that checks if a git commit is being made without
 * creating a required journal entry.
 *
 * This hook:
 * 1. Reads the Bash command from stdin (JSON format from Claude Code hooks)
 * 2. Checks if the command contains 'git commit'
 * 3. If so, reads .claude/context/session.json
 * 4. If journal_required is true and journal_created is not true, blocks the commit
 *
 * Exit codes:
 *   0 - Success (not a git commit, or journal requirements met)
 *   1 - Failure (journal required but not created, or processing error)
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
      console.error('Error: No input provided to journal-commit-check hook');
      process.exit(1);
    }

    let inputData;
    try {
      inputData = JSON.parse(stdinContent);
    } catch (e) {
      console.error(`Error: Invalid JSON input to journal-commit-check hook: ${e.message}`);
      process.exit(1);
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
      console.error('');
      console.error('========================================');
      console.error('WARNING: Journal Entry Not Created');
      console.error('========================================');
      console.error('');
      console.error('A journal entry is required for this workflow but has not been created.');
      console.error('');
      console.error(`Workflow: ${status.workflow}`);
      console.error(`Current phase: ${status.phase}`);
      console.error('');
      console.error('Please create a journal entry before committing:');
      console.error('  1. Create journal entry in .claude/journal/entries/');
      console.error('  2. Run: node .claude/scripts/session-checkpoint.mjs journal-created <path>');
      console.error('');
      console.error('Blocking commit until journal entry is created.');
      console.error('========================================');
      console.error('');
      process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    console.error(`Error in journal-commit-check hook: ${err.message}`);
    process.exit(1);
  }
}

main();
