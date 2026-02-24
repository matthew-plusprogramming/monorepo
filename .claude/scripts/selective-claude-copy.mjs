#!/usr/bin/env node
/**
 * Selective .claude Context Copy Utility (AS-004)
 *
 * Provides:
 * 1. selectiveCopyClaudeDir() - Copies only operational items from .claude/
 * 2. extractSpecGroupId() - Extracts spec group ID from branch names
 * 3. cleanupExcludedDirs() - Removes excluded directories from .claude/
 *
 * AC1.1: CLAUDE_INCLUDE_LIST contains: skills, agents, templates, scripts,
 *         schemas, specs/schema, settings.json
 * AC1.2: selectiveCopyClaudeDir copies only items in CLAUDE_INCLUDE_LIST
 * AC1.3: Returns { copied, skipped } summary
 * AC1.4: Items not in include list are NOT copied
 * AC1.5: Missing source items are skipped gracefully
 * AC2.1-AC2.3: extractSpecGroupId parses sg-* branch names
 * AC3.1-AC3.2: cleanupExcludedDirs removes state directories
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Hardcoded include list for selective .claude copy (AC1.1).
 * Only these items are copied to worktrees.
 *
 * @type {string[]}
 */
export const CLAUDE_INCLUDE_LIST = [
  'skills',
  'agents',
  'templates',
  'scripts',
  'schemas',
  'specs/schema',
  'settings.json',
];

/**
 * Recursively copy a file or directory from source to target.
 *
 * @param {string} sourcePath - Source path (file or directory)
 * @param {string} targetPath - Target path
 */
function copyRecursive(sourcePath, targetPath) {
  const stats = statSync(sourcePath);

  if (stats.isFile()) {
    const parentDir = dirname(targetPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    copyFileSync(sourcePath, targetPath);
    return;
  }

  if (stats.isDirectory()) {
    if (!existsSync(targetPath)) {
      mkdirSync(targetPath, { recursive: true });
    }

    const entries = readdirSync(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      // Skip symlinks for safety
      if (entry.isSymbolicLink()) {
        continue;
      }

      const childSource = join(sourcePath, entry.name);
      const childTarget = join(targetPath, entry.name);
      copyRecursive(childSource, childTarget);
    }
  }
}

/**
 * Selectively copy .claude directory contents from source to target (AC1.2).
 * Only copies items in CLAUDE_INCLUDE_LIST.
 *
 * @param {string} sourceDir - Source .claude directory path
 * @param {string} targetDir - Target .claude directory path
 * @returns {{ copied: string[], skipped: string[] }} Summary of copied and skipped items
 */
export function selectiveCopyClaudeDir(sourceDir, targetDir) {
  const copied = [];
  const skipped = [];

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  for (const item of CLAUDE_INCLUDE_LIST) {
    const sourcePath = join(sourceDir, item);
    const targetPath = join(targetDir, item);

    if (existsSync(sourcePath)) {
      copyRecursive(sourcePath, targetPath);
      copied.push(item);
    } else {
      // AC1.5: Missing source items skipped gracefully
      skipped.push(item);
    }
  }

  return { copied, skipped };
}

/**
 * Extract spec group ID from a git branch name (AC2.1-AC2.3).
 * Recognizes the pattern: sg-<feature-name>/<action>
 *
 * @param {string | null | undefined} branchName - Git branch name
 * @returns {string | null} Spec group ID or null if pattern doesn't match
 */
export function extractSpecGroupId(branchName) {
  // AC2.3: Handle null, undefined, or non-string input
  if (!branchName || typeof branchName !== 'string') {
    return null;
  }

  // AC2.1: Pattern sg-<feature-name>/<action>
  const match = branchName.match(/^(sg-[a-z0-9-]+)\//);

  // AC2.2: Returns null for non-matching patterns
  return match ? match[1] : null;
}

/**
 * Recursively remove a directory and its contents.
 * @param {string} dirPath - Directory path to remove
 */
function rmSyncRecursive(dirPath) {
  if (!existsSync(dirPath)) {
    return;
  }

  const stats = statSync(dirPath);
  if (stats.isFile()) {
    unlinkSync(dirPath);
    return;
  }

  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      rmSyncRecursive(fullPath);
    } else {
      unlinkSync(fullPath);
    }
  }

  rmdirSync(dirPath);
}

/**
 * Clean up excluded directories from an existing .claude directory (AC3.1).
 * Removes state directories that should not be present in worktrees.
 *
 * @param {string} claudeDir - Path to .claude directory to clean
 * @returns {string[]} List of directories that were removed (AC3.2)
 */
export function cleanupExcludedDirs(claudeDir) {
  // INC-007: Uses 'journal' (singular) per CLAUDE.md convention
  const EXCLUDE_DIRS = [
    'specs/groups',
    'specs/archive',
    'context',
    'memory-bank',
    'journal',
    'docs',
    'contracts',
  ];

  const removed = [];

  for (const dir of EXCLUDE_DIRS) {
    const dirPath = join(claudeDir, dir);
    if (existsSync(dirPath)) {
      try {
        rmSyncRecursive(dirPath);
        removed.push(dir);
      } catch {
        // Ignore errors - directory may already be gone
      }
    }
  }

  return removed;
}
