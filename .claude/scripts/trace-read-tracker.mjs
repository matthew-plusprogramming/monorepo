#!/usr/bin/env node

/**
 * Trace Read Tracker PostToolUse Hook
 *
 * PostToolUse hook on Read that records trace file reads in session state
 * at `.claude/coordination/trace-reads.json`. When an agent reads a trace
 * file (`.claude/traces/**`), this script determines which module(s) the
 * trace covers and records them with timestamps.
 *
 * Invocation: Reads stdin JSON from Claude Code PostToolUse hook system.
 * Input format: { session_id: string, tool_input: { file_path: string } }
 *
 * Behavior:
 * - Reading high-level.md records ALL modules from trace.config.json as read (AC-6.1)
 * - Reading low-level/<module-id>.md records only that module as read (AC-6.2)
 * - Creates trace-reads.json if it does not exist (AC-6.3)
 * - Multiple reads append/update without losing prior state (AC-6.4)
 * - If session_id changes, clears old reads and starts fresh
 * - Always exits 0 (silent logging, never blocks)
 *
 * Exit codes:
 *   0 - Always (silent logging, never blocks agent work)
 *
 * Implements: REQ-AT-019
 * Spec: as-007-trace-read-tracker
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { loadTraceConfig, matchesGlob, resolveProjectRoot } from './lib/trace-utils.mjs';

/** Path to session state file relative to project root */
const TRACE_READS_RELATIVE_PATH = '.claude/coordination/trace-reads.json';

/** Glob pattern for trace files */
const TRACE_FILE_PATTERN = '.claude/traces/**';

/**
 * Read all stdin as a string.
 *
 * @returns {Promise<string>} Raw stdin content
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Determine which module IDs a trace file covers.
 *
 * - high-level.md or high-level.json: covers ALL modules in trace.config.json
 * - low-level/<module-id>.md or .json: covers only that specific module
 *
 * @param {string} filePath - The trace file path (relative to project root)
 * @param {object} config - Parsed trace.config.json
 * @returns {string[]} Array of module IDs covered by this trace file
 */
export function traceFileToModuleIds(filePath, config) {
  const name = basename(filePath);
  const parentDir = basename(dirname(filePath));

  // AC-6.1: High-level trace covers all modules
  if (name.startsWith('high-level')) {
    return config.modules.map(m => m.id);
  }

  // AC-6.2: Low-level trace covers only the specific module
  if (parentDir === 'low-level') {
    // Extract module ID from filename: "dev-team.md" -> "dev-team"
    const moduleId = name.replace(/\.(md|json)$/, '');

    // Verify the module exists in config
    const moduleExists = config.modules.some(m => m.id === moduleId);
    if (moduleExists) {
      return [moduleId];
    }

    // Module not found in config -- return empty (no modules recorded)
    return [];
  }

  // Unknown trace file structure -- return empty
  return [];
}

/**
 * Load existing trace-reads.json or return a fresh structure.
 *
 * If the file does not exist, returns a new structure (AC-6.3).
 * If the session_id has changed, clears old reads and starts fresh.
 *
 * @param {string} filePath - Absolute path to trace-reads.json
 * @param {string} sessionId - Current session ID
 * @returns {{ session_id: string, reads: Record<string, string> }}
 */
export function loadOrCreateTraceReads(filePath, sessionId) {
  const freshState = { session_id: sessionId, reads: {} };

  if (!existsSync(filePath)) {
    // AC-6.3: File does not exist -- create fresh
    return freshState;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const existing = JSON.parse(raw);

    // If session_id changed, clear old reads and start fresh
    if (existing.session_id !== sessionId) {
      return freshState;
    }

    // Validate structure
    if (typeof existing.reads !== 'object' || existing.reads === null) {
      return freshState;
    }

    return existing;
  } catch {
    // Malformed file -- start fresh
    return freshState;
  }
}

/**
 * Write trace-reads.json with atomic rename.
 *
 * Writes to a temp file first, then renames, to avoid corruption
 * from concurrent hook executions. On POSIX systems, rename on
 * the same filesystem is atomic.
 *
 * @param {string} filePath - Absolute path to trace-reads.json
 * @param {object} data - The trace reads state to persist
 */
export function writeTraceReads(filePath, data) {
  const dir = dirname(filePath);

  // Ensure the coordination directory exists (AC-6.3)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write atomically: write to temp file then rename
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Main hook entry point.
 *
 * Reads stdin JSON, determines which trace file was read,
 * maps it to module ID(s), and updates trace-reads.json.
 */
async function main() {
  try {
    // Read stdin JSON from Claude Code hook system
    const stdinContent = await readStdin();

    if (!stdinContent.trim()) {
      // No input -- exit silently
      process.exit(0);
    }

    let inputData;
    try {
      inputData = JSON.parse(stdinContent);
    } catch {
      // Malformed JSON -- exit silently (never block)
      process.exit(0);
    }

    // Extract session_id and file_path from stdin JSON
    const sessionId = inputData.session_id || 'unknown';
    const toolInput = inputData.tool_input || {};
    const filePath = toolInput.file_path;

    if (!filePath || typeof filePath !== 'string') {
      // No file path -- exit silently
      process.exit(0);
    }

    // Normalize file path for pattern matching
    // Remove absolute path prefix if present, keeping relative path from project root
    const projectRoot = resolveProjectRoot();
    let relativePath = filePath;
    if (filePath.startsWith(projectRoot)) {
      relativePath = filePath.slice(projectRoot.length).replace(/^\//, '');
    }

    // Check if file matches trace file pattern
    if (!matchesGlob(relativePath, TRACE_FILE_PATTERN)) {
      // Not a trace file -- exit silently
      process.exit(0);
    }

    // Load trace config to get module definitions
    let config;
    try {
      config = loadTraceConfig(projectRoot);
    } catch {
      // No trace config -- exit silently (no modules to record)
      process.exit(0);
    }

    // Determine which modules this trace file covers
    const moduleIds = traceFileToModuleIds(relativePath, config);

    if (moduleIds.length === 0) {
      // No modules to record -- exit silently
      process.exit(0);
    }

    // Load or create trace-reads.json
    const traceReadsPath = join(projectRoot, TRACE_READS_RELATIVE_PATH);
    const state = loadOrCreateTraceReads(traceReadsPath, sessionId);

    // AC-6.4: Record the timestamp for each module (additive updates)
    const now = new Date().toISOString();
    for (const moduleId of moduleIds) {
      state.reads[moduleId] = now;
    }

    // Write updated state
    writeTraceReads(traceReadsPath, state);

    process.exit(0);
  } catch {
    // Any unexpected error -- exit silently (never block agent work)
    process.exit(0);
  }
}

main();
