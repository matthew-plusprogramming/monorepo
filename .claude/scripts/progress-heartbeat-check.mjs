#!/usr/bin/env node

/**
 * Progress Heartbeat Check Hook
 *
 * Monitors progress updates during spec implementation and enforces checkpoint discipline.
 * This hook triggers on Edit/Write operations within active spec scope.
 *
 * Behavior:
 * 1. Detects if an active spec exists (manifest.json with work_state: IMPLEMENTING)
 * 2. Checks time since last_progress_update
 * 3. Warning: If > 15 minutes since last progress update
 * 4. Block: After 3 consecutive ignored warnings (heartbeat_warnings >= 3)
 * 5. Reset: heartbeat_warnings resets to 0 when progress is logged
 *
 * Graceful degradation:
 * - If no active spec found, exits silently (0)
 * - If manifest can't be read, exits silently (0)
 * - Warnings are advisory, blocking requires explicit threshold
 *
 * Usage (via hook-wrapper):
 *   node .claude/scripts/hook-wrapper.mjs '.claude/specs/**' 'node .claude/scripts/progress-heartbeat-check.mjs {{file}}'
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path, { dirname, join, resolve, basename } from 'node:path';

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const MAX_WARNINGS_BEFORE_BLOCK = 3;

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
    if (basename(currentDir) === '.claude') {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return join(process.cwd(), '.claude');
}

/**
 * Find the spec group directory from a file path.
 * Returns the spec group path if the file is within a spec group, null otherwise.
 */
function findSpecGroupDir(filePath) {
  const claudeDir = findClaudeDir();
  const specGroupsDir = join(claudeDir, 'specs', 'groups');

  // Normalize path for cross-platform compatibility before checking
  const normalizedPath = filePath.split(path.sep).join('/');

  // Check if file is within specs/groups
  if (!normalizedPath.includes('/specs/groups/')) {
    return null;
  }

  // Extract the spec group directory
  const relativePath = filePath.split('/specs/groups/')[1];
  if (!relativePath) return null;

  const specGroupId = relativePath.split('/')[0];
  const specGroupDir = join(specGroupsDir, specGroupId);

  if (existsSync(join(specGroupDir, 'manifest.json'))) {
    return specGroupDir;
  }

  return null;
}

/**
 * Load manifest from spec group directory.
 */
function loadManifest(specGroupDir) {
  const manifestPath = join(specGroupDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Save manifest to spec group directory.
 */
function saveManifest(specGroupDir, manifest) {
  const manifestPath = join(specGroupDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * Check if the spec is actively being implemented.
 */
function isActiveImplementation(manifest) {
  return manifest?.work_state === 'IMPLEMENTING';
}

/**
 * Calculate time since last progress update.
 * Returns null if no last_progress_update is set.
 */
function getTimeSinceLastUpdate(manifest) {
  if (!manifest.last_progress_update) {
    return null;
  }

  const lastUpdate = new Date(manifest.last_progress_update);
  const now = new Date();
  return now - lastUpdate;
}

/**
 * Check if this file edit represents a progress update.
 * Progress updates are detected by:
 * - Edits to manifest.json (updating last_progress_update directly)
 * - Edits to atomic spec files (updating Implementation Evidence or Decision Log)
 */
function isProgressUpdate(filePath, content) {
  // If editing manifest and it contains last_progress_update, it's a progress update
  if (filePath.endsWith('manifest.json')) {
    return true;
  }

  // If editing an atomic spec and adding implementation evidence or decision log
  if (filePath.includes('/atomic/') && filePath.endsWith('.md')) {
    // Check if the content has implementation evidence or decision log updates
    // This is a heuristic - we check for common patterns
    if (
      content?.includes('## Implementation Evidence') ||
      content?.includes('## Decision Log') ||
      content?.includes('status: implemented') ||
      content?.includes('status: implementing')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Main heartbeat check logic.
 */
function checkHeartbeat(filePath, fileContent) {
  const specGroupDir = findSpecGroupDir(filePath);

  if (!specGroupDir) {
    // Not within a spec group, exit silently
    return { status: 'ok', message: null };
  }

  const manifest = loadManifest(specGroupDir);

  if (!manifest) {
    // Can't load manifest, exit silently
    return { status: 'ok', message: null };
  }

  if (!isActiveImplementation(manifest)) {
    // Not in IMPLEMENTING state, no heartbeat needed
    return { status: 'ok', message: null };
  }

  // Check if this edit is itself a progress update
  if (isProgressUpdate(filePath, fileContent)) {
    // Reset warnings on progress update
    if (manifest.heartbeat_warnings > 0) {
      manifest.heartbeat_warnings = 0;
      manifest.updated_at = new Date().toISOString();
      saveManifest(specGroupDir, manifest);
      return {
        status: 'ok',
        message: `Heartbeat: Progress detected. Warnings reset to 0.`
      };
    }
    return { status: 'ok', message: null };
  }

  // Check time since last progress update
  const timeSinceUpdate = getTimeSinceLastUpdate(manifest);

  if (timeSinceUpdate === null) {
    // No last_progress_update set - this is the first activity
    // Set it now and exit ok
    manifest.last_progress_update = new Date().toISOString();
    manifest.heartbeat_warnings = 0;
    manifest.updated_at = new Date().toISOString();
    saveManifest(specGroupDir, manifest);
    return {
      status: 'ok',
      message: `Heartbeat: Initialized progress tracking.`
    };
  }

  if (timeSinceUpdate < STALE_THRESHOLD_MS) {
    // Within threshold, all good
    return { status: 'ok', message: null };
  }

  // Stale - issue warning or block
  const currentWarnings = manifest.heartbeat_warnings || 0;
  const minutesSinceUpdate = Math.round(timeSinceUpdate / 60000);

  if (currentWarnings >= MAX_WARNINGS_BEFORE_BLOCK) {
    // Block threshold reached
    return {
      status: 'block',
      message: `HEARTBEAT BLOCK: ${minutesSinceUpdate} minutes since last progress update.\n` +
        `${MAX_WARNINGS_BEFORE_BLOCK} warnings ignored. Please update the spec's Implementation Evidence or Decision Log.\n` +
        `To unblock: Add progress to the atomic spec or update manifest.last_progress_update.`
    };
  }

  // Increment warning counter
  manifest.heartbeat_warnings = currentWarnings + 1;
  manifest.updated_at = new Date().toISOString();
  saveManifest(specGroupDir, manifest);

  return {
    status: 'warn',
    message: `HEARTBEAT WARNING (${manifest.heartbeat_warnings}/${MAX_WARNINGS_BEFORE_BLOCK}): ` +
      `${minutesSinceUpdate} minutes since last progress update.\n` +
      `Please update the spec's Implementation Evidence or Decision Log.\n` +
      `After ${MAX_WARNINGS_BEFORE_BLOCK} warnings, edits will be blocked.`
  };
}

/**
 * Read file content if it exists.
 */
function readFileContent(filePath) {
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf-8');
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // No file provided, exit silently
    process.exit(0);
  }

  const filePath = resolve(args[0]);
  const fileContent = readFileContent(filePath);

  const result = checkHeartbeat(filePath, fileContent);

  if (result.message) {
    if (result.status === 'block') {
      console.error(result.message);
      // AC3.4: Block after 3 consecutive ignored warnings
      process.exit(1);
    } else {
      console.log(result.message);
    }
  }

  process.exit(0);
}

main();
