#!/usr/bin/env node

/**
 * Dirty Manifest Check Hook
 *
 * PostToolUse hook that warns when git commit runs while spec-group
 * manifest.json files relevant to the commit have uncommitted changes.
 *
 * This hook:
 * 1. Reads the Bash command from stdin (JSON format from Claude Code hooks)
 * 2. Checks if the command contains 'git commit'
 * 3. If so, runs git status --porcelain to find dirty manifest files
 * 4. Scopes warnings to manifests whose spec group had files in the commit
 *    or whose work_state is IMPLEMENTING or VERIFYING
 * 5. If relevant dirty manifests found, prints warning to stderr and exits
 *    with code 2
 *
 * Exit codes:
 *   0 - No issues (non-commit command, no dirty manifests, or none relevant)
 *   2 - Warning: relevant dirty manifests found (stderr shown to Claude)
 *
 * Usage:
 *   Triggered automatically as a PostToolUse hook for Bash commands
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Work states that indicate active implementation.
 * Only manifests in these states are flagged by the work_state fallback.
 * All other states (DRAFTING, APPROVED, REVIEWING, MERGED, DONE, etc.)
 * are ignored unless the commit touches their spec group directory.
 */
const ACTIVE_WORK_STATES = new Set(['IMPLEMENTING', 'VERIFYING']);

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
 * Extract the spec group ID (directory name) from a manifest path.
 * Expected format: .claude/specs/groups/<sg-id>/manifest.json
 * Returns null if the path doesn't match the expected pattern.
 */
function extractSpecGroupId(manifestPath) {
  const match = manifestPath.match(
    /\.claude\/specs\/groups\/([^/]+)\/manifest\.json$/,
  );
  return match ? match[1] : null;
}

/**
 * Get the list of files included in the most recent commit.
 * Returns a Set of file paths, or an empty Set if the commit history
 * is unavailable (e.g., first commit in the repo).
 *
 * Timing: This hook runs as PostToolUse (after `git commit` completes),
 * so HEAD is the just-created commit. `HEAD~1..HEAD` correctly returns
 * the files from the commit that just happened.
 *
 * Known limitation: `git commit --amend` may not capture all
 * originally-relevant files, since HEAD~1..HEAD only shows the diff
 * between the amended commit and its parent, not the original commit's
 * file set.
 */
function getCommittedFiles() {
  try {
    const output = execSync('git diff --name-only HEAD~1..HEAD', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const files = new Set();
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        files.add(trimmed);
      }
    }
    return files;
  } catch {
    // HEAD~1 doesn't exist (first commit) or other git error.
    // Fall back to listing all files in the HEAD commit tree.
    try {
      const output = execSync(
        'git diff-tree --no-commit-id --name-only -r HEAD',
        {
          encoding: 'utf-8',
          timeout: 5000,
        },
      );
      const files = new Set();
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          files.add(trimmed);
        }
      }
      return files;
    } catch {
      // Can't determine committed files at all — return empty set.
      // This means only work_state-based matching will apply.
      return new Set();
    }
  }
}

/**
 * Read a manifest file and return its work_state, or null if unreadable.
 */
function readManifestWorkState(manifestPath) {
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content);
    return manifest.work_state || null;
  } catch {
    // File doesn't exist on disk, isn't valid JSON, or other read error.
    return null;
  }
}

/**
 * Determine whether a dirty manifest is relevant to the current commit.
 *
 * A manifest is relevant if:
 *   1. Any committed file lives under the same spec group directory, OR
 *   2. The manifest's work_state is actively implementing (IMPLEMENTING or VERIFYING)
 */
function isRelevantManifest(manifest, committedFiles) {
  const specGroupId = extractSpecGroupId(manifest.path);
  if (!specGroupId) {
    // Can't determine spec group — include it to be safe
    return true;
  }

  // Check if any committed file belongs to this spec group
  const specGroupPrefix = `.claude/specs/groups/${specGroupId}/`;
  for (const file of committedFiles) {
    if (file.startsWith(specGroupPrefix)) {
      return true;
    }
  }

  // Check if the manifest's work_state indicates active implementation
  const workState = readManifestWorkState(manifest.path);
  if (workState && ACTIVE_WORK_STATES.has(workState)) {
    return true;
  }

  return false;
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

    // Scope to manifests relevant to this commit
    const committedFiles = getCommittedFiles();
    const relevantManifests = dirtyManifests.filter((m) =>
      isRelevantManifest(m, committedFiles),
    );

    if (relevantManifests.length === 0) {
      process.exit(0);
    }

    // Build warning message and print to stderr
    process.stderr.write('\n');
    process.stderr.write('========================================\n');
    process.stderr.write(
      'WARNING: Spec-group manifests were not included in this commit\n',
    );
    process.stderr.write('========================================\n');
    process.stderr.write('\n');
    for (const manifest of relevantManifests) {
      process.stderr.write(`  - ${manifest.path} (${manifest.status})\n`);
    }
    process.stderr.write('\n');
    process.stderr.write(
      'Manifests track convergence state and should be committed alongside\n',
    );
    process.stderr.write(
      'the implementation they describe. Amend this commit or create a\n',
    );
    process.stderr.write('follow-up commit to include them.\n');
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
