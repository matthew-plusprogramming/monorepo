#!/usr/bin/env node

/**
 * Dirty Manifest Check Hook
 *
 * PostToolUse hook that warns when git commit runs while spec-group
 * manifest.json files have uncommitted changes.
 *
 * This hook:
 * 1. Reads the Bash command from stdin (JSON format from Claude Code hooks)
 * 2. Checks if the command contains 'git commit'
 * 3. If so, runs git status --porcelain to find dirty manifest files
 * 4. If dirty manifests found under .claude/specs/groups/, prints warning
 *    to stderr and exits with code 2
 *
 * Exit codes:
 *   0 - No issues (non-commit command, or no dirty manifests)
 *   2 - Warning: dirty manifests found (stderr shown to Claude)
 *
 * Usage:
 *   Triggered automatically as a PostToolUse hook for Bash commands
 */

import { execSync } from 'node:child_process';

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

  return /\bgit\s+commit\b/i.test(command);
}

/**
 * Classify a git status code into a human-readable label.
 */
function classifyStatus(statusCode) {
  if (statusCode === '??') {
    return 'untracked';
  }
  return 'modified';
}

/**
 * Find dirty manifest.json files under .claude/specs/groups/.
 * Returns array of { path, status } objects.
 */
function findDirtyManifests() {
  // Scope git status to .claude/specs/groups/ for efficiency and to ensure
  // untracked files are listed individually (not as directory entries).
  let output;
  try {
    output = execSync(
      'git status --porcelain -- ".claude/specs/groups/**/manifest.json"',
      {
        encoding: 'utf-8',
        timeout: 5000,
      },
    );
  } catch {
    // If git status fails (e.g. no .claude/specs/groups/ dir), don't block
    return [];
  }

  if (!output || !output.trim()) {
    return [];
  }

  const dirtyManifests = [];
  const lines = output.split('\n');

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    // git status --porcelain format: XY <path>
    // X = staging area status, Y = working tree status
    // First two chars are the status code, then a space, then the path
    const statusCode = line.substring(0, 2).trim();
    const filePath = line.substring(3).trim();

    // Verify the path ends with manifest.json (filter out directory entries)
    if (!filePath.endsWith('manifest.json')) {
      continue;
    }

    // Match modified (M, MM, AM) or untracked (??) files
    if (/^(M|MM|AM|\?\?| M)$/.test(statusCode)) {
      dirtyManifests.push({
        path: filePath,
        status: classifyStatus(statusCode),
      });
    }
  }

  return dirtyManifests;
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

    // Quick bail-out: not a git commit command
    if (!isGitCommitCommand(command)) {
      process.exit(0);
    }

    // Check for dirty manifests
    const dirtyManifests = findDirtyManifests();

    if (dirtyManifests.length === 0) {
      process.exit(0);
    }

    // Build warning message and print to stderr
    process.stderr.write('\n');
    process.stderr.write('========================================\n');
    process.stderr.write(
      'WARNING: Spec-group manifests have uncommitted changes\n',
    );
    process.stderr.write('========================================\n');
    process.stderr.write('\n');
    for (const manifest of dirtyManifests) {
      process.stderr.write(`  - ${manifest.path} (${manifest.status})\n`);
    }
    process.stderr.write('\n');
    process.stderr.write('Consider updating manifests before committing.\n');
    process.stderr.write('========================================\n');
    process.stderr.write('\n');

    // Exit 2 so PostToolUse shows stderr to Claude as a warning
    process.exit(2);
  } catch (err) {
    process.stderr.write(
      `Error in dirty-manifest-check hook: ${err.message}\n`,
    );
    // Don't block on hook errors — exit cleanly
    process.exit(0);
  }
}

main();
