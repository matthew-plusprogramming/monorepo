#!/usr/bin/env node

/**
 * Trace Read Enforcement PreToolUse Hook
 *
 * PreToolUse hook on Edit|Write that blocks edits to files in traced modules
 * unless the agent has read the module's trace in this session. Untraced files
 * are allowed with an advisory message to stderr.
 *
 * Invocation: Receives stdin JSON from Claude Code PreToolUse hook system.
 * Input format: { session_id: string, hook_event_name: string, tool_name: string, tool_input: { file_path: string } }
 *
 * Behavior:
 * - If trace.config.json does not exist: exit 0 (AC-7.4, no trace system configured)
 * - If file does not match any module: exit 0 with advisory to stderr (AC-7.3)
 * - If module trace has been read (in trace-reads.json for this session): exit 0 (AC-7.2)
 * - If module trace has NOT been read: exit 2 with block message (AC-7.1)
 * - If trace-reads.json does not exist: all modules treated as unread (AC-7.5)
 *
 * Exit codes:
 *   0 - Allow edit (trace read, untraced file, or no trace system)
 *   2 - Block edit (traced module, trace not read in this session)
 *
 * Implements: REQ-AT-017, REQ-AT-018
 * Spec: as-008-trace-read-enforcement
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadTraceConfig,
  fileToModule,
  resolveProjectRoot,
  TRACE_CONFIG_PATH,
} from './lib/trace-utils.mjs';

/** Path to session state file relative to project root */
const TRACE_READS_RELATIVE_PATH = '.claude/coordination/trace-reads.json';

/** TTL for trace reads in milliseconds (5 minutes). Reads older than this are treated as expired. */
const TRACE_READ_TTL_MS = 5 * 60 * 1000;

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
 * Load trace-reads.json for the given session.
 *
 * Returns the reads map if the file exists and the session_id matches.
 * Returns null if the file does not exist (AC-7.5: all modules treated as unread).
 * Returns null if the session_id does not match (different session = unread).
 *
 * @param {string} filePath - Absolute path to trace-reads.json
 * @param {string} sessionId - Current session ID from stdin
 * @returns {Record<string, string> | null} Map of moduleId -> timestamp, or null
 */
function loadTraceReadsForSession(filePath, sessionId) {
  if (!existsSync(filePath)) {
    // AC-7.5: File does not exist -> all modules treated as unread
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    // Session must match
    if (data.session_id !== sessionId) {
      return null;
    }

    if (typeof data.reads !== 'object' || data.reads === null) {
      return null;
    }

    return data.reads;
  } catch {
    // Malformed file -> treat as if it doesn't exist
    return null;
  }
}

/**
 * Determine the trace file path for a module.
 *
 * Returns the path to the module's low-level trace markdown file,
 * which agents should read before editing module files.
 *
 * @param {string} moduleId - Module identifier
 * @returns {string} Relative path to the trace file
 */
function getTraceFilePathForModule(moduleId) {
  return `.claude/traces/low-level/${moduleId}.md`;
}

/**
 * Main hook entry point.
 *
 * Flow:
 * 1. Parse stdin JSON for file_path and session_id
 * 2. If no trace.config.json -> exit 0 (AC-7.4)
 * 3. Map file to module via fileToModule()
 * 4. If untraced file -> exit 0 with advisory (AC-7.3)
 * 5. Check trace-reads.json for this session
 * 6. If module trace read -> exit 0 (AC-7.2)
 * 7. If module trace NOT read -> exit 2 with block message (AC-7.1)
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

    // Extract session_id and file_path from stdin JSON
    const sessionId = inputData.session_id || 'unknown';
    const toolInput = inputData.tool_input || {};
    const filePath = toolInput.file_path;

    if (!filePath || typeof filePath !== 'string') {
      // No file path -- fail open
      process.exit(0);
    }

    // Step 2: Resolve project root and check if trace system exists
    const projectRoot = resolveProjectRoot();
    const configPath = join(projectRoot, TRACE_CONFIG_PATH);

    // AC-7.4: If trace.config.json does not exist, exit 0 (no trace system)
    if (!existsSync(configPath)) {
      process.exit(0);
    }

    // Step 3: Load config
    let config;
    try {
      config = loadTraceConfig(projectRoot);
    } catch {
      // Config exists but is malformed -- fail open
      process.exit(0);
    }

    // Step 4: Normalize file path and map to module
    // Remove absolute path prefix to get relative path for glob matching
    let relativePath = filePath;
    if (filePath.startsWith(projectRoot)) {
      relativePath = filePath.slice(projectRoot.length).replace(/^\//, '');
    }

    const mod = fileToModule(relativePath, config);

    // AC-7.3: Untraced file -- allow with advisory
    if (!mod) {
      process.stderr.write(
        'Advisory: This file is not covered by any trace module. No trace enforcement applied.\n',
      );
      process.exit(0);
    }

    // Step 5: Check trace-reads.json for this session
    const traceReadsPath = join(projectRoot, TRACE_READS_RELATIVE_PATH);
    const reads = loadTraceReadsForSession(traceReadsPath, sessionId);

    // Step 6: AC-7.2 -- If the module trace has been read and is within TTL, allow edit
    if (reads && mod.id in reads) {
      const readTimestamp = new Date(reads[mod.id]).getTime();
      const isWithinTtl = Date.now() - readTimestamp < TRACE_READ_TTL_MS;
      if (isWithinTtl) {
        process.exit(0);
      }
      // TTL expired -- fall through to block message
    }

    // Step 7: AC-7.1 -- Module trace NOT read, block with exit code 2
    const traceFile = getTraceFilePathForModule(mod.id);

    // Determine if this is an expiry or a first-time block
    const isExpired = reads && mod.id in reads;

    process.stderr.write('\n');
    process.stderr.write('========================================\n');
    process.stderr.write(isExpired ? 'BLOCKED: Trace Read Expired\n' : 'BLOCKED: Trace Not Read\n');
    process.stderr.write('========================================\n');
    process.stderr.write('\n');
    if (isExpired) {
      process.stderr.write(
        `Your trace read for module '${mod.id}' (${mod.name}) has expired. Trace reads expire after 5 minutes.\n`,
      );
    } else {
      process.stderr.write(
        `You must read the architecture trace before editing files in module '${mod.id}' (${mod.name}).\n`,
      );
    }
    process.stderr.write('\n');
    process.stderr.write(`Read \`${traceFile}\` before editing files in module '${mod.id}'\n`);
    process.stderr.write('\n');
    process.stderr.write('Or read the high-level trace to unlock all modules:\n');
    process.stderr.write('  Read \`.claude/traces/high-level.md\`\n');
    process.stderr.write('\n');
    process.stderr.write('Note: Trace reads expire after 5 minutes. Re-read the trace to continue editing.\n');
    process.stderr.write('\n');
    process.stderr.write('========================================\n');
    process.stderr.write('\n');

    process.exit(2);
  } catch (err) {
    // Don't block on hook errors -- fail open
    process.stderr.write(`Error in trace-read-enforcement hook: ${err.message}\n`);
    process.exit(0);
  }
}

main();
