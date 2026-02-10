#!/usr/bin/env node

/**
 * Validate spec-manifest synchronization.
 *
 * Detects drift between manifest.json work_state and spec.md task checkboxes.
 * When manifest indicates completion (READY_TO_MERGE or VERIFYING), but spec.md
 * has unchecked task boxes, this indicates a drift that should be addressed.
 *
 * Usage:
 *   node validate-spec-manifest-sync.mjs <manifest.json>
 *
 * Exit codes:
 *   0 - No drift detected (or not in completion state)
 *   1 - Drift detected: manifest shows completion but spec has unchecked tasks
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';

/**
 * States that indicate the work should be complete.
 * If manifest is in one of these states, all tasks should be checked.
 */
const COMPLETION_STATES = ['READY_TO_MERGE', 'VERIFYING'];

/**
 * Parse manifest.json and return the work_state.
 * Returns null if file doesn't exist or is invalid JSON.
 */
function getManifestWorkState(manifestPath) {
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content);
    return manifest.work_state || null;
  } catch {
    return null;
  }
}

/**
 * Find spec.md in the same directory as manifest.json.
 * Returns the path if found, null otherwise.
 */
function findSpecFile(manifestPath) {
  const dir = dirname(manifestPath);
  const specPath = join(dir, 'spec.md');

  if (existsSync(specPath)) {
    return specPath;
  }

  return null;
}

/**
 * Count unchecked task boxes in the Task List section of spec.md.
 *
 * Looks for the "## Task List" section and counts occurrences of "- [ ]"
 * (unchecked checkbox in markdown).
 *
 * Returns the count of unchecked boxes, or null if Task List section not found.
 */
function countUncheckedTasks(specPath) {
  if (!existsSync(specPath)) {
    return null;
  }

  try {
    const content = readFileSync(specPath, 'utf-8');

    // Find the Task List section
    const taskListMatch = content.match(/^##\s+Task\s+List\s*$/im);
    if (!taskListMatch) {
      // No Task List section found
      return null;
    }

    // Extract content from Task List section to next ## heading or end of file
    const startIndex = taskListMatch.index + taskListMatch[0].length;
    const remainingContent = content.slice(startIndex);

    // Find the next ## heading (if any)
    const nextSectionMatch = remainingContent.match(/^##\s+/m);
    const taskListContent = nextSectionMatch
      ? remainingContent.slice(0, nextSectionMatch.index)
      : remainingContent;

    // Count unchecked boxes: "- [ ]" pattern
    const uncheckedPattern = /^[\s]*-\s+\[\s\]/gm;
    const matches = taskListContent.match(uncheckedPattern);

    return matches ? matches.length : 0;
  } catch {
    return null;
  }
}

/**
 * Validate that manifest work_state and spec task checkboxes are in sync.
 */
function validateSync(manifestPath) {
  const resolvedPath = resolve(manifestPath);

  // Check manifest exists
  if (!existsSync(resolvedPath)) {
    console.error(`Error: Manifest not found: ${resolvedPath}`);
    return { valid: false, error: 'manifest_not_found' };
  }

  // Get work state
  const workState = getManifestWorkState(resolvedPath);
  if (!workState) {
    // Cannot determine work state, skip validation
    return { valid: true, skipped: true, reason: 'no_work_state' };
  }

  // Only validate if in a completion state
  if (!COMPLETION_STATES.includes(workState)) {
    // Not in completion state, no drift check needed
    return { valid: true, skipped: true, reason: 'not_completion_state', workState };
  }

  // Find corresponding spec.md
  const specPath = findSpecFile(resolvedPath);
  if (!specPath) {
    console.error(`Warning: No spec.md found for manifest at ${resolvedPath}`);
    return { valid: true, skipped: true, reason: 'no_spec_file' };
  }

  // Count unchecked tasks
  const uncheckedCount = countUncheckedTasks(specPath);
  if (uncheckedCount === null) {
    console.error(`Warning: Could not find Task List section in ${specPath}`);
    return { valid: true, skipped: true, reason: 'no_task_list' };
  }

  // Check for drift
  if (uncheckedCount > 0) {
    return {
      valid: false,
      drift: true,
      workState,
      uncheckedCount,
      specPath,
      manifestPath: resolvedPath,
    };
  }

  return { valid: true, workState, specPath };
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: validate-spec-manifest-sync.mjs <manifest.json>');
    console.error('Detects drift between manifest.json work_state and spec.md task checkboxes.');
    console.error('Error: No manifest file provided.');
    process.exit(1);
  }

  const manifestPath = args[0];
  const result = validateSync(manifestPath);

  if (result.skipped) {
    // Validation skipped, exit cleanly
    process.exit(0);
  }

  if (result.error) {
    process.exit(1);
  }

  if (result.drift) {
    console.error(`Warning: Spec-manifest drift detected!`);
    console.error(`  Manifest work_state: ${result.workState}`);
    console.error(`  Unchecked tasks in spec: ${result.uncheckedCount}`);
    console.error(`  Spec file: ${result.specPath}`);
    console.error(`  Manifest file: ${result.manifestPath}`);
    console.error('');
    console.error('The manifest indicates completion but spec.md has unchecked task boxes.');
    console.error('Either check off completed tasks in spec.md or update manifest work_state.');
    process.exit(1);
  }

  // Valid, no drift
  console.error(`Validated: ${basename(manifestPath)} - work_state=${result.workState}, all tasks checked.`);
  process.exit(0);
}

main();
