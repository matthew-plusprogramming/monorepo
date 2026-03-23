#!/usr/bin/env node

/**
 * Trace Diff Script (PR Architectural Change Summary)
 *
 * Generates a human-readable architectural change summary by comparing
 * trace data between the current branch and a base branch. Suitable for
 * inclusion in PR descriptions.
 *
 * Shows:
 *   - New/removed modules
 *   - New/removed exports per module
 *   - Changed dependencies (new/removed edges)
 *   - New/removed call graph edges
 *   - New/removed event patterns
 *
 * Usage:
 *   node .claude/scripts/trace-diff.mjs                  # Compare against main
 *   node .claude/scripts/trace-diff.mjs --base <branch>  # Compare against specific branch
 *
 * Implements: REQ-023 (PR Trace Diff Summary)
 * Spec: sg-trace-v2-docs-bridge, Task 5.1
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  resolveProjectRoot,
  HIGH_LEVEL_TRACE_PATH,
  LOW_LEVEL_TRACE_DIR,
} from './lib/trace-utils.mjs';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_BASE_BRANCH = 'main';
const NO_CHANGES_MESSAGE = 'No architectural changes detected.';

/**
 * Pattern for valid git ref names (branch, tag, commit hash).
 * Rejects shell metacharacters while allowing typical ref formats.
 */
const VALID_GIT_REF_PATTERN = /^[a-zA-Z0-9._\/-]+$/;

// =============================================================================
// Input Validation
// =============================================================================

/**
 * Validate a git ref (branch name, tag, commit hash) is safe for use.
 *
 * Defense-in-depth: execFileSync already prevents shell injection, but
 * rejecting unexpected characters catches malformed input early.
 *
 * @param {string} ref - Git ref to validate
 * @throws {Error} If ref contains invalid characters
 */
function validateGitRef(ref) {
  if (!VALID_GIT_REF_PATTERN.test(ref)) {
    throw new Error(`Invalid git ref: "${ref}" contains disallowed characters`);
  }
}

// =============================================================================
// Trace Loading
// =============================================================================

/**
 * Load the high-level trace JSON from the current working tree.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {object|null} Parsed high-level trace or null if not found
 */
function loadCurrentHighLevelTrace(projectRoot) {
  const tracePath = join(projectRoot, HIGH_LEVEL_TRACE_PATH);
  if (!existsSync(tracePath)) return null;
  try {
    return JSON.parse(readFileSync(tracePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Load all low-level trace JSON files from the current working tree.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {Map<string, object>} Map of moduleId -> trace data
 */
function loadCurrentLowLevelTraces(projectRoot) {
  const traces = new Map();
  const dir = join(projectRoot, LOW_LEVEL_TRACE_DIR);
  if (!existsSync(dir)) return traces;

  try {
    const jsonFiles = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of jsonFiles) {
      try {
        const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
        const moduleId = basename(file, '.json');
        traces.set(moduleId, data);
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // Directory read failed
  }

  return traces;
}

/**
 * Load the high-level trace JSON from a specific git ref (branch/tag/commit).
 *
 * Uses `git show <ref>:<path>` to read the file at the given ref without
 * checking out the branch.
 *
 * @param {string} ref - Git ref (branch name, tag, commit hash)
 * @param {string} projectRoot - Absolute path to project root
 * @returns {object|null} Parsed high-level trace or null if not found
 */
function loadRefHighLevelTrace(ref, projectRoot) {
  try {
    validateGitRef(ref);
    const content = execFileSync(
      'git',
      ['show', `${ref}:${HIGH_LEVEL_TRACE_PATH}`],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Load all low-level trace JSON files from a specific git ref.
 *
 * Lists files in the low-level trace directory at the given ref, then
 * reads each JSON file via `git show`.
 *
 * @param {string} ref - Git ref (branch name, tag, commit hash)
 * @param {string} projectRoot - Absolute path to project root
 * @returns {Map<string, object>} Map of moduleId -> trace data
 */
function loadRefLowLevelTraces(ref, projectRoot) {
  const traces = new Map();

  try {
    // List files in the low-level trace directory at the given ref
    validateGitRef(ref);
    const listing = execFileSync(
      'git',
      ['ls-tree', '--name-only', `${ref}:${LOW_LEVEL_TRACE_DIR}`],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const jsonFiles = listing.trim().split('\n').filter(f => f.endsWith('.json'));

    for (const file of jsonFiles) {
      try {
        const content = execFileSync(
          'git',
          ['show', `${ref}:${LOW_LEVEL_TRACE_DIR}/${file}`],
          { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const data = JSON.parse(content);
        const moduleId = basename(file, '.json');
        traces.set(moduleId, data);
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // No low-level traces at this ref
  }

  return traces;
}

// =============================================================================
// Diff Computation
// =============================================================================

/**
 * Compute the diff between two sets of trace data.
 *
 * @param {object|null} baseHighLevel - High-level trace from base branch (null if none)
 * @param {Map<string, object>} baseLowLevel - Low-level traces from base branch
 * @param {object|null} currentHighLevel - High-level trace from current branch (null if none)
 * @param {Map<string, object>} currentLowLevel - Low-level traces from current branch
 * @returns {object} Diff result with sections for modules, exports, dependencies, calls, events
 */
export function computeTraceDiff(baseHighLevel, baseLowLevel, currentHighLevel, currentLowLevel) {
  const diff = {
    newModules: [],
    removedModules: [],
    exportChanges: [],     // { moduleId, added: [], removed: [] }
    dependencyChanges: [], // { moduleId, added: [], removed: [] }
    callChanges: [],       // { moduleId, added: [], removed: [] }
    eventChanges: [],      // { moduleId, added: [], removed: [] }
  };

  // Determine module sets
  const baseModuleIds = baseHighLevel
    ? new Set(baseHighLevel.modules.map(m => m.id))
    : new Set();
  const currentModuleIds = currentHighLevel
    ? new Set(currentHighLevel.modules.map(m => m.id))
    : new Set();

  // New/removed modules
  for (const id of currentModuleIds) {
    if (!baseModuleIds.has(id)) {
      const mod = currentHighLevel.modules.find(m => m.id === id);
      diff.newModules.push({ id, name: mod?.name || id });
    }
  }
  for (const id of baseModuleIds) {
    if (!currentModuleIds.has(id)) {
      const mod = baseHighLevel.modules.find(m => m.id === id);
      diff.removedModules.push({ id, name: mod?.name || id });
    }
  }

  // Compare low-level traces for modules present in both or only in current
  const allModuleIds = new Set([...baseLowLevel.keys(), ...currentLowLevel.keys()]);

  for (const moduleId of allModuleIds) {
    const baseTrace = baseLowLevel.get(moduleId);
    const currentTrace = currentLowLevel.get(moduleId);

    // If module only exists in one side, all entries are added/removed
    if (!baseTrace && currentTrace) {
      // Everything is new -- already captured as newModules at high level
      const allExports = collectExports(currentTrace);
      const allCalls = collectCalls(currentTrace);
      const allEvents = collectEvents(currentTrace);
      if (allExports.length > 0) {
        diff.exportChanges.push({ moduleId, added: allExports, removed: [] });
      }
      if (allCalls.length > 0) {
        diff.callChanges.push({ moduleId, added: allCalls, removed: [] });
      }
      if (allEvents.length > 0) {
        diff.eventChanges.push({ moduleId, added: allEvents, removed: [] });
      }
      continue;
    }
    if (baseTrace && !currentTrace) {
      // Everything is removed -- already captured as removedModules at high level
      const allExports = collectExports(baseTrace);
      const allCalls = collectCalls(baseTrace);
      const allEvents = collectEvents(baseTrace);
      if (allExports.length > 0) {
        diff.exportChanges.push({ moduleId, added: [], removed: allExports });
      }
      if (allCalls.length > 0) {
        diff.callChanges.push({ moduleId, added: [], removed: allCalls });
      }
      if (allEvents.length > 0) {
        diff.eventChanges.push({ moduleId, added: [], removed: allEvents });
      }
      continue;
    }

    // Both exist -- compare exports, calls, events
    const baseExports = collectExports(baseTrace);
    const currentExports = collectExports(currentTrace);
    const exportDiff = diffStringArrays(
      baseExports.map(e => e.key),
      currentExports.map(e => e.key),
    );
    if (exportDiff.added.length > 0 || exportDiff.removed.length > 0) {
      diff.exportChanges.push({
        moduleId,
        added: exportDiff.added.map(k => currentExports.find(e => e.key === k)),
        removed: exportDiff.removed.map(k => baseExports.find(e => e.key === k)),
      });
    }

    const baseCalls = collectCalls(baseTrace);
    const currentCalls = collectCalls(currentTrace);
    const callDiff = diffStringArrays(
      baseCalls.map(c => c.key),
      currentCalls.map(c => c.key),
    );
    if (callDiff.added.length > 0 || callDiff.removed.length > 0) {
      diff.callChanges.push({
        moduleId,
        added: callDiff.added.map(k => currentCalls.find(c => c.key === k)),
        removed: callDiff.removed.map(k => baseCalls.find(c => c.key === k)),
      });
    }

    const baseEvents = collectEvents(baseTrace);
    const currentEvents = collectEvents(currentTrace);
    const eventDiff = diffStringArrays(
      baseEvents.map(e => e.key),
      currentEvents.map(e => e.key),
    );
    if (eventDiff.added.length > 0 || eventDiff.removed.length > 0) {
      diff.eventChanges.push({
        moduleId,
        added: eventDiff.added.map(k => currentEvents.find(e => e.key === k)),
        removed: eventDiff.removed.map(k => baseEvents.find(e => e.key === k)),
      });
    }
  }

  // Compare high-level dependencies for modules present in both
  if (baseHighLevel && currentHighLevel) {
    for (const currentMod of currentHighLevel.modules) {
      const baseMod = baseHighLevel.modules.find(m => m.id === currentMod.id);
      if (!baseMod) continue; // New module -- deps already captured

      const baseDeps = (baseMod.dependencies || []).map(d => depKey(d));
      const currentDeps = (currentMod.dependencies || []).map(d => depKey(d));
      const depDiff = diffStringArrays(baseDeps, currentDeps);
      if (depDiff.added.length > 0 || depDiff.removed.length > 0) {
        diff.dependencyChanges.push({
          moduleId: currentMod.id,
          added: depDiff.added,
          removed: depDiff.removed,
        });
      }
    }

    // Check for dependency changes in removed modules
    for (const baseMod of baseHighLevel.modules) {
      if (!currentHighLevel.modules.find(m => m.id === baseMod.id)) {
        const baseDeps = (baseMod.dependencies || []).map(d => depKey(d));
        if (baseDeps.length > 0) {
          diff.dependencyChanges.push({
            moduleId: baseMod.id,
            added: [],
            removed: baseDeps,
          });
        }
      }
    }
  }

  return diff;
}

// =============================================================================
// Collection Helpers
// =============================================================================

/**
 * Collect all exports from a low-level trace as keyed entries.
 *
 * @param {object} trace - Low-level trace data
 * @returns {Array<{ key: string, symbol: string, type: string, file: string }>}
 */
function collectExports(trace) {
  const exports = [];
  if (!trace.files) return exports;

  for (const file of trace.files) {
    if (!Array.isArray(file.exports)) continue;
    for (const exp of file.exports) {
      exports.push({
        key: `${file.filePath}::${exp.symbol}`,
        symbol: exp.symbol,
        type: exp.type,
        file: file.filePath,
      });
    }
  }
  return exports;
}

/**
 * Collect all calls from a low-level trace as keyed entries.
 *
 * @param {object} trace - Low-level trace data
 * @returns {Array<{ key: string, callerFile: string, callerLine: number, calleeName: string }>}
 */
function collectCalls(trace) {
  const calls = [];
  if (!trace.files) return calls;

  for (const file of trace.files) {
    if (!Array.isArray(file.calls)) continue;
    for (const call of file.calls) {
      calls.push({
        key: `${call.callerFile}:${call.callerLine}->${call.calleeName}`,
        callerFile: call.callerFile,
        callerLine: call.callerLine,
        calleeName: call.calleeName,
      });
    }
  }
  return calls;
}

/**
 * Collect all events from a low-level trace as keyed entries.
 *
 * @param {object} trace - Low-level trace data
 * @returns {Array<{ key: string, file: string, line: number, eventName: string, type: string }>}
 */
function collectEvents(trace) {
  const events = [];
  if (!trace.files) return events;

  for (const file of trace.files) {
    if (!Array.isArray(file.events)) continue;
    for (const evt of file.events) {
      events.push({
        key: `${evt.file}:${evt.line}:${evt.eventName}:${evt.type}`,
        file: evt.file,
        line: evt.line,
        eventName: evt.eventName,
        type: evt.type,
      });
    }
  }
  return events;
}

/**
 * Create a unique key for a dependency entry.
 *
 * @param {object|string} dep - Dependency entry (string or { targetId, relationshipType, description })
 * @returns {string}
 */
function depKey(dep) {
  return typeof dep === 'string' ? dep : dep.targetId || dep;
}

/**
 * Compute added/removed items between two string arrays.
 *
 * @param {string[]} base - Base array
 * @param {string[]} current - Current array
 * @returns {{ added: string[], removed: string[] }}
 */
function diffStringArrays(base, current) {
  const baseSet = new Set(base);
  const currentSet = new Set(current);

  const added = current.filter(item => !baseSet.has(item));
  const removed = base.filter(item => !currentSet.has(item));

  return { added, removed };
}

// =============================================================================
// Diff Formatting
// =============================================================================

/**
 * Check if a diff result has any changes.
 *
 * @param {object} diff - Result from computeTraceDiff
 * @returns {boolean}
 */
export function hasChanges(diff) {
  return (
    diff.newModules.length > 0 ||
    diff.removedModules.length > 0 ||
    diff.exportChanges.length > 0 ||
    diff.dependencyChanges.length > 0 ||
    diff.callChanges.length > 0 ||
    diff.eventChanges.length > 0
  );
}

/**
 * Format a trace diff as a human-readable markdown summary.
 *
 * EC-7: When no trace changes detected, outputs "No architectural changes detected."
 *
 * @param {object} diff - Result from computeTraceDiff
 * @returns {string} Markdown-formatted summary
 */
export function formatTraceDiff(diff) {
  if (!hasChanges(diff)) {
    return NO_CHANGES_MESSAGE;
  }

  const lines = [];
  lines.push('## Architectural Changes');
  lines.push('');

  // New/removed modules
  if (diff.newModules.length > 0) {
    lines.push('### New Modules');
    lines.push('');
    for (const mod of diff.newModules) {
      lines.push(`- **${mod.name}** (\`${mod.id}\`)`);
    }
    lines.push('');
  }

  if (diff.removedModules.length > 0) {
    lines.push('### Removed Modules');
    lines.push('');
    for (const mod of diff.removedModules) {
      lines.push(`- **${mod.name}** (\`${mod.id}\`)`);
    }
    lines.push('');
  }

  // Export changes
  if (diff.exportChanges.length > 0) {
    lines.push('### Export Changes');
    lines.push('');
    for (const change of diff.exportChanges) {
      lines.push(`**${change.moduleId}**:`);
      for (const added of change.added) {
        lines.push(`  - + \`${added.symbol}\` (${added.type}) in \`${added.file}\``);
      }
      for (const removed of change.removed) {
        lines.push(`  - - \`${removed.symbol}\` (${removed.type}) in \`${removed.file}\``);
      }
    }
    lines.push('');
  }

  // Dependency changes
  if (diff.dependencyChanges.length > 0) {
    lines.push('### Dependency Changes');
    lines.push('');
    for (const change of diff.dependencyChanges) {
      lines.push(`**${change.moduleId}**:`);
      for (const added of change.added) {
        lines.push(`  - + ${added}`);
      }
      for (const removed of change.removed) {
        lines.push(`  - - ${removed}`);
      }
    }
    lines.push('');
  }

  // Call graph changes
  if (diff.callChanges.length > 0) {
    lines.push('### Call Graph Changes');
    lines.push('');
    for (const change of diff.callChanges) {
      lines.push(`**${change.moduleId}**:`);
      for (const added of change.added) {
        lines.push(`  - + \`${added.calleeName}\` called from \`${added.callerFile}:${added.callerLine}\``);
      }
      for (const removed of change.removed) {
        lines.push(`  - - \`${removed.calleeName}\` called from \`${removed.callerFile}:${removed.callerLine}\``);
      }
    }
    lines.push('');
  }

  // Event changes
  if (diff.eventChanges.length > 0) {
    lines.push('### Event Pattern Changes');
    lines.push('');
    for (const change of diff.eventChanges) {
      lines.push(`**${change.moduleId}**:`);
      for (const added of change.added) {
        lines.push(`  - + ${added.type} \`${added.eventName}\` at \`${added.file}:${added.line}\``);
      }
      for (const removed of change.removed) {
        lines.push(`  - - ${removed.type} \`${removed.eventName}\` at \`${removed.file}:${removed.line}\``);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// =============================================================================
// Main Orchestration
// =============================================================================

/**
 * Generate a trace diff comparing current branch against a base branch.
 *
 * REQ-023: If base branch has no traces, treat everything as "new".
 * EC-7: If no trace changes detected, output "No architectural changes detected."
 *
 * @param {object} [options]
 * @param {string} [options.baseBranch] - Base branch to compare against (default: 'main')
 * @param {string} [options.projectRoot] - Project root override
 * @returns {{ diff: object, formatted: string }}
 */
export function generateTraceDiff(options = {}) {
  const projectRoot = options.projectRoot || resolveProjectRoot();
  const baseBranch = options.baseBranch || DEFAULT_BASE_BRANCH;

  // Load current traces
  const currentHighLevel = loadCurrentHighLevelTrace(projectRoot);
  const currentLowLevel = loadCurrentLowLevelTraces(projectRoot);

  // Load base branch traces
  const baseHighLevel = loadRefHighLevelTrace(baseBranch, projectRoot);
  const baseLowLevel = loadRefLowLevelTraces(baseBranch, projectRoot);

  // Compute diff
  const diff = computeTraceDiff(baseHighLevel, baseLowLevel, currentHighLevel, currentLowLevel);

  // Format output
  const formatted = formatTraceDiff(diff);

  return { diff, formatted };
}

// =============================================================================
// CLI Entry Point
// =============================================================================

/**
 * Parse CLI arguments for trace-diff.
 *
 * @param {string[]} argv - Process arguments
 * @returns {{ baseBranch: string }}
 */
export function parseCliArgs(argv) {
  const args = argv.slice(2);
  let baseBranch = DEFAULT_BASE_BRANCH;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base' && args[i + 1]) {
      baseBranch = args[++i];
    }
  }

  return { baseBranch };
}

async function main() {
  try {
    const { baseBranch } = parseCliArgs(process.argv);
    const { formatted } = generateTraceDiff({ baseBranch });
    console.log(formatted);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Trace diff failed: ${err.message}\n`);
    process.exit(1);
  }
}

// Run main only if executed directly (not imported as a module by tests)
const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('trace-diff.mjs') &&
  !process.argv[1].endsWith('.test.mjs');

if (isMainModule) {
  main();
}
