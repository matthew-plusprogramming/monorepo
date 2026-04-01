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

import { readFileSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';


// === Performance Caches (AC-1, AC-6) ===

/** Module-scoped cache for git ls-files result (AC-1). Populated on first call, reused thereafter. */
let cachedGitFiles = null;

/** Module-scoped cache for compiled regex objects keyed by glob pattern (AC-6). */
const regexCache = new Map();

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
    // AC-6: Use cached compiled regex to avoid redundant globToRegex() + new RegExp() calls
    let regex = regexCache.get(p);
    if (!regex) {
      const regexStr = globToRegex(p);
      // Pattern can match:
      // 1. The entire path
      // 2. The end of the path (for patterns like *.json)
      // 3. A suffix after / (for patterns like .claude/agents/*.md)
      regex = new RegExp('(^|/)' + regexStr + '$');
      regexCache.set(p, regex);
    }
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
 * Map a file path to ALL matching modules (all-match semantics).
 *
 * Unlike fileToModule() which returns the first match, this returns all
 * modules whose fileGlobs match the given path. Used for dependency
 * resolution to detect ambiguous file glob configurations (REQ-002).
 *
 * @param {string} filePath - File path to resolve (relative to project root)
 * @param {{ modules: Array<{ id: string, name: string, fileGlobs: string[] }> }} config - Trace config
 * @returns {Array<{ id: string, name: string, fileGlobs: string[] }>} All matching modules (may be empty)
 */
export function fileToModules(filePath, config) {
  if (!filePath || typeof filePath !== 'string') {
    return [];
  }

  if (!config || !Array.isArray(config.modules)) {
    return [];
  }

  // Normalize the file path: remove leading ./ or / for consistent matching
  const normalizedPath = filePath.replace(/^\.\//, '').replace(/^\//, '');

  const matches = [];
  for (const mod of config.modules) {
    for (const glob of mod.fileGlobs) {
      if (matchesGlob(normalizedPath, glob)) {
        matches.push(mod);
        break; // This module matched, no need to check more globs for it
      }
    }
  }

  return matches;
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
 * M2 extension (REQ-008): When called with optional fourth parameter `options`,
 * performs file-level granularity staleness checks using staleness.json.
 * Existing callers using `isTraceStale(moduleId, config, root)` are unaffected.
 *
 * @param {string} moduleId - Module identifier to check
 * @param {{ modules: Array<{ id: string, fileGlobs: string[] }> }} config - Trace config
 * @param {string} [projectRoot] - Optional project root override
 * @param {object} [options] - M2 options for file-level staleness
 * @param {string} [options.filePath] - Check staleness of specific file
 * @param {boolean} [options.useStalenessStore] - Use staleness.json for checking
 * @returns {boolean} True if stale (module-level or file-level depending on options)
 */
export function isTraceStale(moduleId, config, projectRoot, options) {
  const root = projectRoot || resolveProjectRoot();

  // M2: File-level staleness via staleness.json
  if (options && options.useStalenessStore) {
    const staleness = loadStalenessMetadata(root);
    if (!staleness) {
      // No staleness data -- treat as stale (will trigger --full)
      return true;
    }

    // If a specific file is requested, check only that file
    if (options.filePath) {
      return isFileStale(options.filePath, moduleId, staleness.data, root);
    }

    // Check all files in the module
    const mod = config.modules.find(m => m.id === moduleId);
    if (!mod) return false;

    const matchingFiles = findFilesMatchingGlobs(mod.fileGlobs, root);
    for (const filePath of matchingFiles) {
      if (isFileStale(filePath, moduleId, staleness.data, root)) {
        return true;
      }
    }
    return false;
  }

  // Original behavior: module-level staleness via mtime comparison
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
    // AC-1: Use cached git ls-files result to avoid repeated subprocess spawns.
    // The cache is populated on first call and reused for all subsequent calls
    // within the same generation run.
    let allFiles = cachedGitFiles;
    if (!allFiles) {
      allFiles = execSync('git ls-files', {
        encoding: 'utf-8',
        cwd: root,
        timeout: 10000,
      })
        .trim()
        .split('\n')
        .filter(Boolean);
      cachedGitFiles = allFiles;
    }

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
 * Reset all module-scoped caches.
 *
 * Clears the cached git ls-files result (AC-1) and compiled regex cache (AC-6).
 * Call this when fresh state is needed (e.g., between test runs or when
 * the working tree has changed).
 */
export function resetFileCache() {
  cachedGitFiles = null;
  regexCache.clear();
}

/**
 * Prime the git files cache with pre-computed results.
 *
 * Used by worker threads to avoid redundant git ls-files subprocess calls.
 * Each worker receives the cached file list from the main thread and primes
 * its own module-scoped cache.
 *
 * @param {string[]} files - Array of relative file paths from git ls-files
 */
export function primeGitFilesCache(files) {
  cachedGitFiles = files;
}

/**
 * Get the current cached git files, or null if not yet populated.
 *
 * Used by the parallel dispatcher to pass cached files to workers.
 *
 * @returns {string[] | null}
 */
export function getCachedGitFiles() {
  return cachedGitFiles;
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

/**
 * CommonMark special characters that must be backslash-escaped in .md output.
 *
 * Escaping order: backslashes first, then all remaining specials.
 * This prevents double-escaping.
 *
 * Implements REQ-025 (NFR-10): Signature sanitization for markdown output.
 */
const COMMONMARK_SPECIAL_CHARS = ['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '|'];

/**
 * Backslash-escape CommonMark special characters in text for .md output.
 *
 * Applies to symbol names, signature, and signatureRaw values when rendering
 * to .md trace files. JSON files store raw unescaped values.
 *
 * Escaping order: backslashes (`\`) first, then remaining specials.
 * This prevents double-escaping.
 *
 * @param {string} text - Raw text to sanitize
 * @returns {string} Text with CommonMark specials backslash-escaped
 */
export function sanitizeMarkdown(text) {
  if (!text) return text;

  let result = text;
  for (const ch of COMMONMARK_SPECIAL_CHARS) {
    // Escape each special character by replacing it with backslash + character
    result = result.split(ch).join('\\' + ch);
  }
  return result;
}

// =============================================================================
// Staleness Metadata Store (M2: REQ-006, REQ-011, REQ-012)
// =============================================================================

/** Default path to staleness.json relative to project root */
const STALENESS_JSON_RELATIVE_PATH = '.claude/traces/staleness.json';

/** Current schema version for staleness.json */
const STALENESS_SCHEMA_VERSION = 1;

/** Maximum propagation depth for cross-module staleness (REQ-007) */
const MAX_PROPAGATION_DEPTH = 3;

/** Trace file size soft warning threshold in bytes (REQ-013) */
const TRACE_SIZE_SOFT_WARNING_BYTES = 500 * 1024;

/** Trace file size escalation threshold in bytes (REQ-013) */
const TRACE_SIZE_ESCALATION_BYTES = 1024 * 1024;

/**
 * Compute SHA-256 hash of file content for change detection.
 *
 * Task 2.2: Used by staleness system to detect file modifications.
 *
 * @param {string} filePath - Absolute path to the file
 * @returns {string} Hex-encoded SHA-256 hash of file content
 */
export function computeFileHash(filePath, content) {
  // AC-5: When content is provided (from file content cache), hash directly
  // instead of reading from disk. Falls back to readFileSync for backward compat.
  const fileContent = content != null ? content : readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(fileContent).digest('hex');
}

/**
 * Compute export signature hash for a module's exports.
 *
 * Task 2.5: Hash covers "export name + kind + parameter names" for
 * all exports. Excludes JSDoc comments, whitespace, and function bodies.
 * Used to gate cross-module staleness propagation.
 *
 * @param {Array<{ symbol: string, type: string, signature?: string }>} moduleExports - All exports from a module
 * @returns {string} Hex-encoded SHA-256 hash of export signatures
 */
export function computeExportSignatureHash(moduleExports) {
  // Sort exports by symbol name for determinism
  const sorted = [...moduleExports].sort((a, b) => a.symbol.localeCompare(b.symbol));

  // Build canonical representation: "name:kind:paramNames" per export
  const parts = sorted.map(exp => {
    const paramNames = extractParamNames(exp.signature || '');
    return `${exp.symbol}:${exp.type}:${paramNames}`;
  });

  const canonical = parts.join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Extract parameter names from a function signature string.
 *
 * Handles signatures like "(a, b, c)" or "(options = {})" etc.
 * Returns a comma-separated list of parameter names only.
 *
 * @param {string} signature - Function signature string (e.g., "(a, b)")
 * @returns {string} Comma-separated parameter names
 */
function extractParamNames(signature) {
  if (!signature) return '';

  // Extract content between first ( and matching )
  const parenStart = signature.indexOf('(');
  if (parenStart === -1) return '';

  let depth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < signature.length; i++) {
    if (signature[i] === '(') depth++;
    if (signature[i] === ')') depth--;
    if (depth === 0) {
      parenEnd = i;
      break;
    }
  }

  if (parenEnd === -1) return '';

  const inner = signature.slice(parenStart + 1, parenEnd).trim();
  if (!inner) return '';

  // Split on commas (not inside nested parens/brackets)
  const params = [];
  let current = '';
  depth = 0;
  for (const ch of inner) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      params.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) params.push(current.trim());

  // Extract just the name (before =, :, or ?)
  return params.map(p => {
    // Handle destructured params like { a, b } or [a, b]
    if (p.startsWith('{') || p.startsWith('[')) return p.split('=')[0].trim();
    // Handle rest params like ...args
    const name = p.split(/[=:?]/)[0].trim();
    return name;
  }).join(',');
}

/**
 * Validate staleness.json data against the expected schema.
 *
 * Task 2.6 (REQ-011): Validates structure integrity on load.
 * Returns validation result; callers should fall back to --full on failure.
 *
 * @param {*} data - Parsed JSON data to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateStalenessMetadata(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    errors.push('staleness.json must be a non-null object');
    return { valid: false, errors };
  }

  if (data.version !== STALENESS_SCHEMA_VERSION) {
    errors.push(`staleness.json: version must be ${STALENESS_SCHEMA_VERSION}, got ${data.version}`);
  }

  if (!data.modules || typeof data.modules !== 'object') {
    errors.push('staleness.json: modules must be an object');
    return { valid: false, errors };
  }

  for (const [moduleId, modData] of Object.entries(data.modules)) {
    const prefix = `modules.${moduleId}`;

    if (!modData || typeof modData !== 'object') {
      errors.push(`${prefix} must be an object`);
      continue;
    }

    if (typeof modData.exportSignatureHash !== 'string') {
      errors.push(`${prefix}.exportSignatureHash must be a string`);
    }

    if (!modData.files || typeof modData.files !== 'object') {
      errors.push(`${prefix}.files must be an object`);
      continue;
    }

    for (const [filePath, fileData] of Object.entries(modData.files)) {
      const filePrefix = `${prefix}.files["${filePath}"]`;

      if (!fileData || typeof fileData !== 'object') {
        errors.push(`${filePrefix} must be an object`);
        continue;
      }

      if (typeof fileData.hash !== 'string') {
        errors.push(`${filePrefix}.hash must be a string`);
      }
      if (typeof fileData.lastTraced !== 'string') {
        errors.push(`${filePrefix}.lastTraced must be a string`);
      }

      // externalRefs is optional
      if (fileData.externalRefs !== undefined) {
        if (typeof fileData.externalRefs !== 'object' || fileData.externalRefs === null) {
          errors.push(`${filePrefix}.externalRefs must be an object when present`);
        } else {
          for (const [refModId, refSymbols] of Object.entries(fileData.externalRefs)) {
            if (!Array.isArray(refSymbols)) {
              errors.push(`${filePrefix}.externalRefs["${refModId}"] must be an array of strings`);
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Write data to a file using atomic write-rename pattern.
 *
 * Task 2.9 (REQ-012): Writes to a temporary .tmp file first, then
 * atomically renames to the final path. Prevents partial/corrupted
 * files from interrupted operations.
 *
 * @param {string} filePath - Final destination path
 * @param {string} content - File content to write
 */
export function atomicWriteFile(filePath, content) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, filePath);
}

/**
 * Load and validate staleness.json metadata.
 *
 * Task 2.1 (REQ-006): Reads and parses staleness.json with schema
 * validation. Returns null if file is missing, corrupt, or invalid.
 *
 * @param {string} [projectRoot] - Optional project root override
 * @returns {{ data: object, path: string } | null} Parsed staleness data and its path, or null
 */
export function loadStalenessMetadata(projectRoot) {
  const root = projectRoot || resolveProjectRoot();
  const stalenessPath = join(root, STALENESS_JSON_RELATIVE_PATH);

  let raw;
  try {
    raw = readFileSync(stalenessPath, 'utf-8');
  } catch {
    // File does not exist -- not an error, just no staleness data
    return null;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // REQ-011: Corrupt JSON -- log warning, caller falls back to --full
    process.stderr.write('[trace] WARNING: staleness.json contains invalid JSON; will fall back to --full regeneration\n');
    return null;
  }

  const validation = validateStalenessMetadata(data);
  if (!validation.valid) {
    // REQ-011: Schema validation failure -- log warning, caller falls back to --full
    process.stderr.write(`[trace] WARNING: staleness.json failed schema validation: ${validation.errors.join('; ')}; will fall back to --full regeneration\n`);
    return null;
  }

  return { data, path: stalenessPath };
}

/**
 * Write staleness.json metadata using atomic write-rename.
 *
 * Task 2.1 (REQ-006, REQ-012): Writes staleness metadata with
 * atomic write-rename pattern.
 *
 * @param {object} data - Staleness metadata conforming to schema
 * @param {string} [projectRoot] - Optional project root override
 */
export function writeStalenessMetadata(data, projectRoot) {
  const root = projectRoot || resolveProjectRoot();
  const stalenessPath = join(root, STALENESS_JSON_RELATIVE_PATH);
  atomicWriteFile(stalenessPath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Create a fresh staleness.json data structure.
 *
 * @returns {{ version: number, modules: {} }} Empty staleness metadata
 */
export function createEmptyStalenessData() {
  return {
    version: STALENESS_SCHEMA_VERSION,
    modules: {},
  };
}

/**
 * Check if a specific file within a module is stale using staleness.json.
 *
 * Task 2.3 (REQ-005): Compares current file hash against stored hash.
 * Returns true if hash differs or file is not in staleness data.
 *
 * @param {string} filePath - Relative path to file
 * @param {string} moduleId - Module the file belongs to
 * @param {object} stalenessData - Parsed staleness.json data
 * @param {string} projectRoot - Absolute project root
 * @returns {boolean} True if file is stale (needs regeneration)
 */
export function isFileStale(filePath, moduleId, stalenessData, projectRoot) {
  // Module not in staleness data -- file is stale
  if (!stalenessData.modules[moduleId]) {
    return true;
  }

  const moduleData = stalenessData.modules[moduleId];
  const fileData = moduleData.files[filePath];

  // File not in staleness data -- stale
  if (!fileData) {
    return true;
  }

  // Compare current hash to stored hash
  try {
    const absPath = resolve(projectRoot, filePath);
    const currentHash = computeFileHash(absPath);
    return currentHash !== fileData.hash;
  } catch {
    // File read failed (deleted?) -- stale
    return true;
  }
}

/**
 * Propagate cross-module staleness when a module's export signature changes.
 *
 * Task 2.6 (REQ-007): When a module's export signature hash changes,
 * marks dependent modules' files as stale via externalRefs lookup.
 * Max propagation depth: 3.
 *
 * @param {string} changedModuleId - Module whose exports changed
 * @param {object} stalenessData - Staleness metadata (mutated in place)
 * @param {string} newExportSigHash - New export signature hash
 * @param {number} [depth=1] - Current propagation depth (internal)
 * @returns {string[]} List of module IDs that were marked as having stale files
 */
export function propagateCrossModuleStaleness(changedModuleId, stalenessData, newExportSigHash, depth = 1) {
  const affectedModules = [];

  if (depth > MAX_PROPAGATION_DEPTH) {
    process.stderr.write(`[trace] WARNING: Cross-module staleness propagation depth exceeded (max ${MAX_PROPAGATION_DEPTH}) for module ${changedModuleId}\n`);
    return affectedModules;
  }

  // Check old vs new export signature hash
  const moduleData = stalenessData.modules[changedModuleId];
  if (!moduleData) return affectedModules;

  const oldHash = moduleData.exportSignatureHash;
  if (oldHash === newExportSigHash) {
    // Export signature unchanged -- no propagation needed
    return affectedModules;
  }

  // Update the export signature hash
  moduleData.exportSignatureHash = newExportSigHash;

  // Find all files in other modules that have externalRefs to the changed module
  for (const [otherModuleId, otherModuleData] of Object.entries(stalenessData.modules)) {
    if (otherModuleId === changedModuleId) continue;

    let moduleAffected = false;
    for (const [filePath, fileData] of Object.entries(otherModuleData.files)) {
      if (fileData.externalRefs && fileData.externalRefs[changedModuleId]) {
        // This file references exports from the changed module -- mark stale by clearing hash
        fileData.hash = '';
        moduleAffected = true;
      }
    }

    if (moduleAffected) {
      affectedModules.push(otherModuleId);
    }
  }

  return affectedModules;
}

/**
 * Check trace file size and emit warnings per REQ-013 thresholds.
 *
 * Task 2.10: Soft warning at 500KB, stderr escalation at 1MB.
 * Generation is never blocked.
 *
 * @param {string} filePath - Path to the trace file to check
 * @param {string} moduleId - Module ID for warning context
 */
export function checkTraceFileSize(filePath, moduleId) {
  try {
    const stat = statSync(filePath);
    const sizeBytes = stat.size;

    if (sizeBytes >= TRACE_SIZE_ESCALATION_BYTES) {
      process.stderr.write(
        `[trace] WARNING: Module "${moduleId}" trace file exceeds 1MB (${(sizeBytes / 1024 / 1024).toFixed(1)}MB). ` +
        `Consider splitting this module into smaller modules.\n`
      );
    } else if (sizeBytes >= TRACE_SIZE_SOFT_WARNING_BYTES) {
      process.stderr.write(
        `[trace] Note: Module "${moduleId}" trace file is ${(sizeBytes / 1024).toFixed(0)}KB (approaching 1MB threshold).\n`
      );
    }
  } catch {
    // File stat failed -- skip size check
  }
}

// =============================================================================
// Trace Integrity Validation (M3: REQ-015)
// =============================================================================

/** Maximum age for trace data in milliseconds (1 year) */
const MAX_TRACE_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Validate trace data integrity before consumption.
 *
 * Task 3.1 (REQ-015): Checks that `generatedBy` and `lastGenerated` fields
 * are present and plausible. On failure, returns `{ valid: false, reason }`.
 * Used by Route skill and hooks before consuming trace data.
 *
 * @param {object} traceData - Parsed trace JSON (high-level or low-level)
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateTraceIntegrity(traceData) {
  if (!traceData || typeof traceData !== 'object') {
    return { valid: false, reason: 'Trace data is null or not an object' };
  }

  // Check generatedBy field is present and non-empty
  if (!traceData.generatedBy || typeof traceData.generatedBy !== 'string' || traceData.generatedBy.trim() === '') {
    return { valid: false, reason: 'Missing or empty "generatedBy" field' };
  }

  // Check lastGenerated field is present
  if (!traceData.lastGenerated || typeof traceData.lastGenerated !== 'string') {
    return { valid: false, reason: 'Missing or invalid "lastGenerated" field' };
  }

  // Parse and validate the timestamp
  const timestamp = new Date(traceData.lastGenerated);
  const timestampMs = timestamp.getTime();

  if (Number.isNaN(timestampMs)) {
    return { valid: false, reason: `"lastGenerated" is not a valid ISO 8601 timestamp: ${traceData.lastGenerated}` };
  }

  const now = Date.now();

  // Reject future timestamps (with 60s tolerance for clock skew)
  const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;
  if (timestampMs > now + CLOCK_SKEW_TOLERANCE_MS) {
    return { valid: false, reason: `"lastGenerated" is in the future: ${traceData.lastGenerated}` };
  }

  // Reject unreasonably old timestamps (older than MAX_TRACE_AGE_MS)
  if (now - timestampMs > MAX_TRACE_AGE_MS) {
    return { valid: false, reason: `"lastGenerated" is unreasonably old (> 1 year): ${traceData.lastGenerated}` };
  }

  return { valid: true };
}

// Export constants for use by other trace scripts
export const TRACE_CONFIG_PATH = TRACE_CONFIG_RELATIVE_PATH;
export const HIGH_LEVEL_TRACE_PATH = HIGH_LEVEL_TRACE_RELATIVE_PATH;
export const LOW_LEVEL_TRACE_DIR = LOW_LEVEL_TRACE_DIR_RELATIVE_PATH;
export const STALENESS_JSON_PATH = STALENESS_JSON_RELATIVE_PATH;
