#!/usr/bin/env node

/**
 * Shared Trace Utilities Library
 *
 * Provides core functions used by all trace system scripts:
 * - loadTraceConfig(): reads and parses trace.config.json
 * - fileToModule(filePath, config): maps a file path to its owning module (first match wins)
 * - isTraceStale(moduleId, config): checks if a module's trace is stale vs source file mtimes
 * - globToRegex(pattern): converts a glob pattern to regex (consistent with hook-wrapper.mjs)
 * - matchesGlob(filePath, pattern): tests a file path against a glob pattern
 *
 * Implements: REQ-AT-003, REQ-AT-007, REQ-AT-022
 * Spec: as-002-trace-utils
 */

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

/** Default path to trace.config.json relative to project root */
const TRACE_CONFIG_RELATIVE_PATH = '.claude/traces/trace.config.json';

/** Default path to high-level trace JSON relative to project root */
const HIGH_LEVEL_TRACE_RELATIVE_PATH = '.claude/traces/high-level.json';

/** Default path to low-level trace directory relative to project root */
const LOW_LEVEL_TRACE_DIR_RELATIVE_PATH = '.claude/traces/low-level';

/**
 * Convert a single glob pattern to a regex string.
 *
 * Replicates the algorithm from hook-wrapper.mjs for consistency (AC-4.4).
 * Supports: * (any non-slash), ** (any including slash), ? (single non-slash char).
 * Escapes regex special characters in literal segments.
 *
 * @param {string} pattern - Glob pattern (e.g., "apps/node-server/src/**")
 * @returns {string} Regex string (without anchors)
 */
export function globToRegex(pattern) {
  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches anything including /
        regexStr += '.*';
        i += 2;
      } else {
        // * matches anything except /
        regexStr += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      // ? matches any single character except /
      regexStr += '[^/]';
      i += 1;
    } else if ('.+^${}()|[]\\'.includes(char)) {
      // Escape regex special characters
      regexStr += '\\' + char;
      i += 1;
    } else {
      regexStr += char;
      i += 1;
    }
  }

  return regexStr;
}

/**
 * Test whether a file path matches a glob pattern.
 *
 * Uses the same matching semantics as hook-wrapper.mjs matchesPattern:
 * the pattern can match the entire path, the end of the path, or
 * a suffix after a / separator.
 *
 * @param {string} filePath - File path to test (e.g., "apps/node-server/src/index.ts")
 * @param {string} pattern - Glob pattern (e.g., "apps/node-server/src/**")
 * @returns {boolean} True if file matches the pattern
 */
export function matchesGlob(filePath, pattern) {
  // Support comma-separated patterns (OR logic), consistent with hook-wrapper.mjs
  const patterns = pattern.split(',').map(p => p.trim());

  for (const p of patterns) {
    const regexStr = globToRegex(p);
    // Pattern can match:
    // 1. The entire path
    // 2. The end of the path (for patterns like *.json)
    // 3. A suffix after / (for patterns like .claude/agents/*.md)
    const regex = new RegExp('(^|/)' + regexStr + '$');
    if (regex.test(filePath)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve the project root directory.
 *
 * Uses CLAUDE_PROJECT_DIR env var if available, otherwise falls back to
 * the git top-level directory, and finally to cwd.
 *
 * @returns {string} Absolute path to the project root
 */
export function resolveProjectRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }

  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (gitRoot) {
      return gitRoot;
    }
  } catch {
    // Fall through to cwd
  }

  return process.cwd();
}

/**
 * Load and parse trace.config.json.
 *
 * Reads the configuration file from the project root and validates its
 * basic structure (must have version and modules array).
 *
 * @param {string} [projectRoot] - Optional project root path override
 * @returns {{ version: number, projectRoot?: string, modules: Array<{ id: string, name: string, description?: string, fileGlobs: string[] }> }} Parsed config
 * @throws {Error} If config file is missing, malformed, or fails validation
 */
export function loadTraceConfig(projectRoot) {
  const root = projectRoot || resolveProjectRoot();
  const configPath = join(root, TRACE_CONFIG_RELATIVE_PATH);

  let raw;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Trace config not found at ${configPath}. Run trace generation to create it.`,
      );
    }
    throw new Error(`Failed to read trace config: ${err.message}`);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse trace config JSON: ${err.message}`);
  }

  // Validate required fields
  if (typeof config.version !== 'number') {
    throw new Error('trace.config.json: "version" must be a number');
  }
  if (!Array.isArray(config.modules)) {
    throw new Error('trace.config.json: "modules" must be an array');
  }

  // Validate each module has required fields
  for (let i = 0; i < config.modules.length; i++) {
    const mod = config.modules[i];
    if (!mod.id || typeof mod.id !== 'string') {
      throw new Error(`trace.config.json: modules[${i}].id must be a non-empty string`);
    }
    if (!mod.name || typeof mod.name !== 'string') {
      throw new Error(`trace.config.json: modules[${i}].name must be a non-empty string`);
    }
    if (!Array.isArray(mod.fileGlobs) || mod.fileGlobs.length === 0) {
      throw new Error(
        `trace.config.json: modules[${i}].fileGlobs must be a non-empty array`,
      );
    }
  }

  return config;
}

/**
 * Map a file path to its owning module.
 *
 * Iterates through modules in config order. For each module, tests the file
 * path against each of the module's fileGlobs. First match wins (AC-4.1, REQ-AT-022).
 * Returns null for untraced files (AC-4.2).
 *
 * @param {string} filePath - File path to resolve (relative to project root)
 * @param {{ modules: Array<{ id: string, name: string, fileGlobs: string[] }> }} config - Trace config
 * @returns {{ id: string, name: string, fileGlobs: string[] } | null} The matching module or null
 */
export function fileToModule(filePath, config) {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }

  if (!config || !Array.isArray(config.modules)) {
    return null;
  }

  // Normalize the file path: remove leading ./ or / for consistent matching
  const normalizedPath = filePath.replace(/^\.\//, '').replace(/^\//, '');

  for (const mod of config.modules) {
    for (const glob of mod.fileGlobs) {
      if (matchesGlob(normalizedPath, glob)) {
        return mod;
      }
    }
  }

  // AC-4.2: No module matched -- untraced file
  return null;
}

/**
 * Get the path to a module's low-level trace JSON file.
 *
 * @param {string} moduleId - Module identifier (e.g., "node-server")
 * @param {string} [projectRoot] - Optional project root override
 * @returns {string} Absolute path to the low-level trace JSON file
 */
export function getTracePath(moduleId, projectRoot) {
  const root = projectRoot || resolveProjectRoot();
  return join(root, LOW_LEVEL_TRACE_DIR_RELATIVE_PATH, `${moduleId}.json`);
}

/**
 * Get the path to the high-level trace JSON file.
 *
 * @param {string} [projectRoot] - Optional project root override
 * @returns {string} Absolute path to the high-level trace JSON file
 */
export function getHighLevelTracePath(projectRoot) {
  const root = projectRoot || resolveProjectRoot();
  return join(root, HIGH_LEVEL_TRACE_RELATIVE_PATH);
}

/**
 * Check whether a module's trace is stale.
 *
 * Compares the module's lastGenerated timestamp (from high-level.json or
 * low-level/<moduleId>.json) against the modification times of files matching
 * the module's fileGlobs. If any source file has an mtime newer than
 * lastGenerated, the trace is stale (AC-4.3, REQ-AT-007).
 *
 * @param {string} moduleId - Module identifier to check
 * @param {{ modules: Array<{ id: string, fileGlobs: string[] }> }} config - Trace config
 * @param {string} [projectRoot] - Optional project root override
 * @returns {boolean} True if the trace is stale (needs regeneration)
 */
export function isTraceStale(moduleId, config, projectRoot) {
  const root = projectRoot || resolveProjectRoot();

  // Find the module in config
  const mod = config.modules.find(m => m.id === moduleId);
  if (!mod) {
    // Module not found in config -- cannot determine staleness
    return false;
  }

  // Read the module's trace file to get lastGenerated
  const tracePath = getTracePath(moduleId, root);
  let traceData;
  try {
    const raw = readFileSync(tracePath, 'utf-8');
    traceData = JSON.parse(raw);
  } catch {
    // If trace file doesn't exist or is malformed, it's stale
    return true;
  }

  if (!traceData.lastGenerated) {
    // No lastGenerated timestamp -- treat as stale
    return true;
  }

  const lastGeneratedTime = new Date(traceData.lastGenerated).getTime();
  if (Number.isNaN(lastGeneratedTime)) {
    // Invalid timestamp -- treat as stale
    return true;
  }

  // Find all files matching the module's globs and check their mtimes
  const matchingFiles = findFilesMatchingGlobs(mod.fileGlobs, root);

  for (const filePath of matchingFiles) {
    try {
      const absPath = resolve(root, filePath);
      const stat = statSync(absPath);
      if (stat.mtimeMs > lastGeneratedTime) {
        // AC-4.3: A source file is newer than lastGenerated -- trace is stale
        return true;
      }
    } catch {
      // File stat failed -- skip (file may have been deleted)
      continue;
    }
  }

  return false;
}

/**
 * Find files matching an array of glob patterns using git ls-files.
 *
 * Uses git ls-files for efficiency (only tracked files) and falls back
 * to a simpler approach if git is unavailable.
 *
 * @param {string[]} globs - Array of glob patterns
 * @param {string} root - Project root directory
 * @returns {string[]} Array of relative file paths matching the globs
 */
export function findFilesMatchingGlobs(globs, root) {
  const matchingFiles = [];

  try {
    // Use git ls-files for the full file list (efficient, respects .gitignore)
    const allFiles = execSync('git ls-files', {
      encoding: 'utf-8',
      cwd: root,
      timeout: 10000,
    })
      .trim()
      .split('\n')
      .filter(Boolean);

    for (const file of allFiles) {
      for (const glob of globs) {
        if (matchesGlob(file, glob)) {
          matchingFiles.push(file);
          break; // File matched, no need to check more globs for this file
        }
      }
    }
  } catch {
    // Git not available -- return empty (callers handle gracefully)
  }

  return matchingFiles;
}

/**
 * Format a timestamp as ISO 8601 string.
 *
 * @param {Date} [date] - Optional date (defaults to now)
 * @returns {string} ISO 8601 timestamp string
 */
export function formatTimestamp(date) {
  return (date || new Date()).toISOString();
}

// Export constants for use by other trace scripts
export const TRACE_CONFIG_PATH = TRACE_CONFIG_RELATIVE_PATH;
export const HIGH_LEVEL_TRACE_PATH = HIGH_LEVEL_TRACE_RELATIVE_PATH;
export const LOW_LEVEL_TRACE_DIR = LOW_LEVEL_TRACE_DIR_RELATIVE_PATH;
