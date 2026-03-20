#!/usr/bin/env node

/**
 * Shared YAML Utilities Library
 *
 * Provides safe YAML parsing, path confinement, freshness hashing,
 * and input size validation for the structured documentation system.
 *
 * All YAML parsing uses the default safe schema (no custom tags).
 * All path operations validate confinement within the project root.
 *
 * Implements: REQ-023 (safe YAML parsing), REQ-024 (path confinement),
 *             REQ-025 (input size limits)
 * Spec: sg-structured-docs, Task 3
 */

import { readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, normalize, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import YAML from 'yaml';

// =============================================================================
// Constants
// =============================================================================

/** Maximum file size in bytes (1MB) */
export const MAX_FILE_SIZE_BYTES = 1_048_576;

/** Maximum number of modules allowed in architecture.yaml */
export const MAX_MODULES_COUNT = 500;

/** Maximum number of flows allowed in flows/index.yaml */
export const MAX_FLOWS_COUNT = 100;

/** Current schema version */
export const CURRENT_SCHEMA_VERSION = 1;

/** Source hash length (first N chars of SHA-256 hex digest) */
export const SOURCE_HASH_LENGTH = 8;

/** Source hash comment prefix in .mmd files */
export const SOURCE_HASH_PREFIX = '%% source-hash: ';

// =============================================================================
// Error Classes
// =============================================================================

/**
 * Base error for structured documentation system.
 * All doc errors carry a category for distinct reporting.
 */
export class DocsError extends Error {
  /**
   * @param {string} message - Human-readable description
   * @param {string} category - Error category (e.g., 'Parse error', 'Schema violation')
   * @param {string} [filePath] - File path associated with the error
   * @param {object} [details] - Additional structured details
   */
  constructor(message, category, filePath, details = {}) {
    super(message);
    this.name = 'DocsError';
    this.category = category;
    this.filePath = filePath;
    this.details = details;
  }
}

// =============================================================================
// YAML Parsing (AC-11.3: Safe parsing only)
// =============================================================================

/**
 * Safely parse YAML content with error handling and location info.
 *
 * Uses the yaml package default safe schema. Never passes customTags option.
 * Provides line/column information on parse errors (REQ-005/AC-5.1).
 *
 * @param {string} content - Raw YAML string to parse
 * @param {string} [filePath] - File path for error reporting
 * @returns {{ data: any, lineCounter: import('yaml').LineCounter | null }}
 * @throws {DocsError} On YAML parse failure with category 'Parse error'
 */
export function safeParseYaml(content, filePath) {
  if (content.length > MAX_FILE_SIZE_BYTES) {
    throw new DocsError(
      `Input exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
      'size-limit',
      filePath,
      { size: content.length, limit: MAX_FILE_SIZE_BYTES },
    );
  }

  try {
    const lineCounter = new YAML.LineCounter();
    const data = YAML.parse(content, { lineCounter });
    return { data, lineCounter };
  } catch (err) {
    const lineInfo = err.linePos
      ? ` (line ${err.linePos[0]?.line ?? '?'}, col ${err.linePos[0]?.col ?? '?'})`
      : '';
    throw new DocsError(
      `YAML parse error in ${filePath || 'unknown'}${lineInfo}: ${err.message}`,
      'Parse error',
      filePath,
      { line: err.linePos?.[0]?.line, col: err.linePos?.[0]?.col },
    );
  }
}

/**
 * Read and parse a YAML file safely.
 *
 * Performs file size check before parsing (AC-11.5).
 * Uses safeParseYaml for safe parsing (AC-11.3).
 *
 * @param {string} filePath - Absolute path to YAML file
 * @returns {{ data: any, content: string }}
 * @throws {DocsError} On size limit violation, read failure, or parse failure
 */
export function readAndParseYaml(filePath) {
  // AC-11.5: Check file size before parsing
  checkFileSize(filePath, MAX_FILE_SIZE_BYTES);

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new DocsError(
        `File not found: ${filePath}`,
        'File error',
        filePath,
      );
    }
    throw new DocsError(
      `Failed to read file: ${filePath}: ${err.message}`,
      'File error',
      filePath,
    );
  }

  const { data } = safeParseYaml(content, filePath);
  return { data, content };
}

// =============================================================================
// Path Confinement (AC-11.4: Reject path traversal)
// =============================================================================

/**
 * Validate that a path resolves within the project root.
 *
 * Resolves the path relative to project root, normalizes it,
 * checks it starts with projectRoot after normalization,
 * resolves symlinks and re-checks confinement,
 * and rejects paths containing '..' segments.
 *
 * @param {string} rawPath - Raw path from YAML document
 * @param {string} projectRoot - Absolute project root path
 * @returns {string} The resolved, validated absolute path
 * @throws {DocsError} On path confinement violation
 */
export function confineToProject(rawPath, projectRoot) {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new DocsError(
      'Path is empty or not a string',
      'Path confinement',
      undefined,
      { rawPath },
    );
  }

  // Reject paths with .. segments before normalization
  if (rawPath.includes('..')) {
    throw new DocsError(
      `Path confinement violation: path contains ".." segments: ${rawPath}`,
      'Path confinement',
      undefined,
      { rawPath },
    );
  }

  const normalizedRoot = resolve(projectRoot);
  const resolvedPath = resolve(normalizedRoot, rawPath);
  const normalizedPath = normalize(resolvedPath);

  // Check confinement after normalization
  if (!normalizedPath.startsWith(normalizedRoot + sep) && normalizedPath !== normalizedRoot) {
    throw new DocsError(
      `Path confinement violation: "${rawPath}" resolves outside project root`,
      'Path confinement',
      undefined,
      { rawPath, resolvedPath: normalizedPath, projectRoot: normalizedRoot },
    );
  }

  // Resolve symlinks and re-check (if path exists)
  // Resolve root through symlinks too (e.g., macOS /tmp -> /private/tmp)
  try {
    const realPath = realpathSync(normalizedPath);
    let realRoot;
    try {
      realRoot = realpathSync(normalizedRoot);
    } catch {
      realRoot = normalizedRoot;
    }
    if (!realPath.startsWith(realRoot + sep) && realPath !== realRoot) {
      throw new DocsError(
        `Path confinement violation: symlink "${rawPath}" resolves outside project root`,
        'Path confinement',
        undefined,
        { rawPath, realPath, projectRoot: realRoot },
      );
    }
    return realPath;
  } catch (err) {
    if (err instanceof DocsError) throw err;
    // Path doesn't exist yet — return the normalized path (confinement already checked)
    return normalizedPath;
  }
}

/**
 * Validate that a flow file reference is confined to the flows/ directory.
 *
 * Additional confinement beyond confineToProject: flow file references
 * must resolve within the flows/ subdirectory specifically (SEC-201).
 *
 * @param {string} fileRef - Flow file reference (e.g., "auth-flow.yaml")
 * @param {string} flowsDir - Absolute path to flows/ directory
 * @param {string} projectRoot - Absolute project root path
 * @returns {string} The resolved, validated absolute path
 * @throws {DocsError} On flow confinement violation
 */
export function confineToFlowsDir(fileRef, flowsDir, projectRoot) {
  // First check general project confinement
  const resolvedInProject = confineToProject(fileRef, flowsDir);

  // Then check flows/ directory confinement
  // Resolve symlinks on flowsDir too (e.g., macOS /tmp -> /private/tmp)
  let normalizedFlowsDir;
  try {
    normalizedFlowsDir = realpathSync(resolve(flowsDir));
  } catch {
    normalizedFlowsDir = resolve(flowsDir);
  }
  if (!resolvedInProject.startsWith(normalizedFlowsDir + sep) && resolvedInProject !== normalizedFlowsDir) {
    throw new DocsError(
      `Flow file confinement violation: "${fileRef}" resolves outside flows/ directory`,
      'Path confinement',
      undefined,
      { fileRef, resolvedPath: resolvedInProject, flowsDir: normalizedFlowsDir },
    );
  }

  return resolvedInProject;
}

// =============================================================================
// File Size Validation (AC-11.5: Reject files > 1MB)
// =============================================================================

/**
 * Check that a file does not exceed the maximum size limit.
 *
 * Size check happens BEFORE YAML parsing to prevent DoS.
 *
 * @param {string} filePath - Absolute path to file
 * @param {number} maxBytes - Maximum allowed size in bytes
 * @throws {DocsError} On size limit violation
 */
export function checkFileSize(filePath, maxBytes) {
  try {
    const stats = statSync(filePath);
    if (stats.size > maxBytes) {
      throw new DocsError(
        `File exceeds size limit: ${filePath} is ${stats.size} bytes (max: ${maxBytes} bytes)`,
        'Size limit',
        filePath,
        { fileSize: stats.size, maxBytes },
      );
    }
  } catch (err) {
    if (err instanceof DocsError) throw err;
    if (err.code === 'ENOENT') {
      throw new DocsError(
        `File not found: ${filePath}`,
        'File error',
        filePath,
      );
    }
    throw new DocsError(
      `Failed to check file size: ${filePath}: ${err.message}`,
      'File error',
      filePath,
    );
  }
}

// =============================================================================
// Freshness Hash (AC-6.3: source-hash computation)
// =============================================================================

/**
 * Normalize line endings to LF.
 *
 * Replaces all \r\n with \n for cross-platform hash consistency.
 *
 * @param {string} content - Raw content
 * @returns {string} Content with LF-normalized line endings
 */
export function lfNormalize(content) {
  return content.replace(/\r\n/g, '\n');
}

/**
 * Compute the source hash for freshness detection.
 *
 * Hash = first 8 chars of SHA-256 hex digest over LF-normalized content.
 *
 * @param {string} content - Raw YAML content
 * @returns {string} 8-character hex hash string
 */
export function computeSourceHash(content) {
  const normalized = lfNormalize(content);
  const hash = createHash('sha256').update(normalized).digest('hex');
  return hash.slice(0, SOURCE_HASH_LENGTH);
}

/**
 * Extract the source hash from a .mmd file's first line.
 *
 * Expected format: `%% source-hash: <8-char-hash>`
 *
 * @param {string} mmdContent - Raw .mmd file content
 * @returns {string | null} Extracted hash or null if not found
 */
export function extractSourceHash(mmdContent) {
  const firstLine = mmdContent.split('\n')[0];
  if (firstLine && firstLine.startsWith(SOURCE_HASH_PREFIX)) {
    return firstLine.slice(SOURCE_HASH_PREFIX.length).trim();
  }
  return null;
}

// =============================================================================
// Utility Exports
// =============================================================================

/**
 * Resolve the structured docs directory for a project.
 *
 * @param {string} projectRoot - Absolute project root path
 * @returns {string} Absolute path to .claude/docs/structured/
 */
export function getStructuredDocsDir(projectRoot) {
  return resolve(projectRoot, '.claude', 'docs', 'structured');
}

/**
 * Resolve the generated output directory for a project.
 *
 * @param {string} projectRoot - Absolute project root path
 * @returns {string} Absolute path to .claude/docs/structured/generated/
 */
export function getGeneratedDir(projectRoot) {
  return resolve(projectRoot, '.claude', 'docs', 'structured', 'generated');
}

// =============================================================================
// Project Root Resolution
// =============================================================================

/**
 * Resolve the project root directory from CLI arguments, environment, or git.
 *
 * Checks (in order):
 * 1. --project-root <path> CLI argument
 * 2. --root <path> CLI argument (alias for test harness)
 * 3. CLAUDE_PROJECT_DIR environment variable
 * 4. git rev-parse --show-toplevel
 * 5. process.cwd() fallback
 *
 * @returns {string} Absolute project root path
 */
export function resolveProjectRoot() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--project-root');
  if (rootIdx !== -1 && args[rootIdx + 1]) {
    return resolve(args[rootIdx + 1]);
  }
  // Also accept --root as alias (used by test harness)
  const rootIdx2 = args.indexOf('--root');
  if (rootIdx2 !== -1 && args[rootIdx2 + 1]) {
    return resolve(args[rootIdx2 + 1]);
  }

  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }

  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // Fall through
  }

  return process.cwd();
}
