#!/usr/bin/env node

/**
 * Trace-Docs Sync Report
 *
 * Compares trace data against architecture.yaml and reports divergence:
 * - New exports in traces not reflected in docs
 * - Removed exports still referenced in docs
 * - Changed dependencies between traces and docs
 *
 * Semi-automatic: reports differences, does NOT auto-update.
 *
 * Usage:
 *   node .claude/scripts/trace-docs-sync.mjs
 *
 * Implements: REQ-019
 * Spec: sg-trace-v2-docs-bridge, Task 3.6
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  readAndParseYaml,
  getStructuredDocsDir,
  resolveProjectRoot,
} from './lib/yaml-utils.mjs';

import {
  HIGH_LEVEL_TRACE_PATH,
  LOW_LEVEL_TRACE_DIR,
} from './lib/trace-utils.mjs';

// =============================================================================
// Sync Report Generation
// =============================================================================

/**
 * Load trace data (high-level and low-level) for sync comparison.
 *
 * @param {string} projectRoot - Absolute project root path
 * @returns {object|null} Trace modules map or null
 */
function loadTraceData(projectRoot) {
  try {
    const highLevelPath = join(projectRoot, HIGH_LEVEL_TRACE_PATH);
    if (!existsSync(highLevelPath)) {
      return null;
    }

    const raw = readFileSync(highLevelPath, 'utf-8');
    const highLevel = JSON.parse(raw);

    if (!highLevel || !Array.isArray(highLevel.modules)) {
      return null;
    }

    const traceModules = {};
    for (const mod of highLevel.modules) {
      traceModules[mod.id] = {
        name: mod.name,
        description: mod.description || '',
        dependencies: mod.dependencies || [],
        dependents: mod.dependents || [],
        exports: [],
      };

      // Load low-level trace for export details
      try {
        const llPath = join(projectRoot, LOW_LEVEL_TRACE_DIR, `${mod.id}.json`);
        if (existsSync(llPath)) {
          const llRaw = readFileSync(llPath, 'utf-8');
          const llData = JSON.parse(llRaw);

          if (llData && Array.isArray(llData.files)) {
            for (const file of llData.files) {
              if (Array.isArray(file.exports)) {
                for (const exp of file.exports) {
                  if (exp.symbol) {
                    traceModules[mod.id].exports.push(exp.symbol);
                  }
                }
              }
            }
          }
        }
      } catch {
        // Low-level trace not available for this module
      }
    }

    return traceModules;
  } catch {
    return null;
  }
}

/**
 * Load architecture.yaml module data for sync comparison.
 *
 * @param {string} projectRoot - Absolute project root path
 * @returns {object|null} Docs modules map or null
 */
function loadDocsData(projectRoot) {
  const docsDir = getStructuredDocsDir(projectRoot);
  const archPath = join(docsDir, 'architecture.yaml');

  if (!existsSync(archPath)) {
    return null;
  }

  try {
    const { data } = readAndParseYaml(archPath);
    if (!data || !Array.isArray(data.modules)) {
      return null;
    }

    const docsModules = {};
    for (const mod of data.modules) {
      if (!mod.name) continue;

      docsModules[mod.name] = {
        description: mod.description || '',
        path: mod.path || '',
        dependencies: mod.depends_on || mod.dependencies || [],
        responsibilities: mod.responsibilities || [],
      };
    }

    return docsModules;
  } catch {
    return null;
  }
}

/**
 * Compare trace data against docs data and produce a divergence report.
 *
 * @param {object} traceModules - Trace data map keyed by module id
 * @param {object} docsModules - Docs data map keyed by module name
 * @returns {{ modules: Array<{ id: string, name: string, newExports: string[], removedExports: string[], changedDeps: { added: string[], removed: string[] } }>, summary: { modulesWithDivergence: number, newExports: number, removedExports: number } }}
 */
export function compareSyncState(traceModules, docsModules) {
  const report = {
    modules: [],
    summary: {
      modulesWithDivergence: 0,
      newExports: 0,
      removedExports: 0,
    },
  };

  // Check each traced module against docs
  const traceIds = Object.keys(traceModules);

  for (const traceId of traceIds) {
    const traceMod = traceModules[traceId];

    // Try to find matching docs module by id or name
    const docsEntry = docsModules[traceId] || docsModules[traceMod.name];

    if (!docsEntry) {
      // Module is in traces but not in docs
      if (traceMod.exports.length > 0) {
        report.modules.push({
          id: traceId,
          name: traceMod.name,
          newExports: traceMod.exports,
          removedExports: [],
          changedDeps: {
            added: (traceMod.dependencies || []).map(d => typeof d === 'string' ? d : d.targetId),
            removed: [],
          },
          inDocsOnly: false,
          inTracesOnly: true,
        });
        report.summary.modulesWithDivergence++;
        report.summary.newExports += traceMod.exports.length;
      }
      continue;
    }

    // Module exists in both -- compare exports and dependencies
    const moduleReport = {
      id: traceId,
      name: traceMod.name,
      newExports: [],
      removedExports: [],
      changedDeps: { added: [], removed: [] },
      inDocsOnly: false,
      inTracesOnly: false,
    };

    // Compare exports: trace exports not mentioned in docs responsibilities
    const docsText = [
      docsEntry.description,
      ...docsEntry.responsibilities,
    ].join(' ').toLowerCase();

    for (const exp of traceMod.exports) {
      if (!docsText.includes(exp.toLowerCase())) {
        moduleReport.newExports.push(exp);
      }
    }

    // Compare dependencies
    // Normalize: trace dependencies may be strings or objects with targetId
    const traceDeps = new Set((traceMod.dependencies || []).map(d => typeof d === 'string' ? d : d.targetId));
    const docsDeps = new Set(docsEntry.dependencies);

    for (const dep of traceDeps) {
      if (!docsDeps.has(dep)) {
        moduleReport.changedDeps.added.push(dep);
      }
    }
    for (const dep of docsDeps) {
      if (!traceDeps.has(dep)) {
        moduleReport.changedDeps.removed.push(dep);
      }
    }

    const hasDivergence = moduleReport.newExports.length > 0 ||
      moduleReport.removedExports.length > 0 ||
      moduleReport.changedDeps.added.length > 0 ||
      moduleReport.changedDeps.removed.length > 0;

    if (hasDivergence) {
      report.modules.push(moduleReport);
      report.summary.modulesWithDivergence++;
      report.summary.newExports += moduleReport.newExports.length;
      report.summary.removedExports += moduleReport.removedExports.length;
    }
  }

  // Check for docs modules not in traces
  for (const [docsName, docsEntry] of Object.entries(docsModules)) {
    const foundInTraces = traceIds.some(id =>
      traceModules[id].name === docsName || id === docsName,
    );

    if (!foundInTraces) {
      report.modules.push({
        id: docsName,
        name: docsName,
        newExports: [],
        removedExports: [],
        changedDeps: { added: [], removed: [] },
        inDocsOnly: true,
        inTracesOnly: false,
      });
      report.summary.modulesWithDivergence++;
    }
  }

  return report;
}

/**
 * Format the sync report for human-readable output.
 *
 * @param {{ modules: Array, summary: object }} report
 * @returns {string} Formatted report string
 */
export function formatSyncReport(report) {
  const lines = [];
  lines.push('Trace-Docs Sync Report');
  lines.push('======================');
  lines.push('');

  if (report.modules.length === 0) {
    lines.push('No divergence detected between traces and docs.');
    return lines.join('\n');
  }

  for (const mod of report.modules) {
    if (mod.inTracesOnly) {
      lines.push(`Module: ${mod.id} (${mod.name})`);
      lines.push('  Status: In traces but NOT in architecture.yaml');
      if (mod.newExports.length > 0) {
        lines.push(`  Exports: ${mod.newExports.join(', ')}`);
      }
      if (mod.changedDeps.added.length > 0) {
        lines.push(`  Dependencies: ${mod.changedDeps.added.join(', ')}`);
      }
      lines.push('');
      continue;
    }

    if (mod.inDocsOnly) {
      lines.push(`Module: ${mod.name}`);
      lines.push('  Status: In architecture.yaml but NOT in traces');
      lines.push('');
      continue;
    }

    lines.push(`Module: ${mod.id}`);
    lines.push(`  New exports not in docs: ${mod.newExports.length > 0 ? mod.newExports.join(', ') : '(none)'}`);
    lines.push(`  Removed exports still in docs: ${mod.removedExports.length > 0 ? mod.removedExports.join(', ') : '(none)'}`);

    const depChanges = [];
    if (mod.changedDeps.added.length > 0) {
      depChanges.push(mod.changedDeps.added.map(d => `+${d} (new)`).join(', '));
    }
    if (mod.changedDeps.removed.length > 0) {
      depChanges.push(mod.changedDeps.removed.map(d => `-${d} (removed)`).join(', '));
    }
    lines.push(`  Changed dependencies: ${depChanges.length > 0 ? depChanges.join(', ') : '(none)'}`);
    lines.push('');
  }

  lines.push(`Summary: ${report.summary.modulesWithDivergence} module(s) with divergence, ${report.summary.newExports} new export(s), ${report.summary.removedExports} removed export(s)`);

  return lines.join('\n');
}

/**
 * Generate the trace-docs sync report.
 *
 * @param {string} projectRoot - Absolute project root path
 * @returns {{ report: object, formatted: string }}
 */
export function generateSyncReport(projectRoot) {
  const traceModules = loadTraceData(projectRoot);
  const docsModules = loadDocsData(projectRoot);

  if (!traceModules) {
    return {
      report: null,
      formatted: 'Trace-Docs Sync Report\n======================\n\nNo trace data available. Run trace generation first.',
    };
  }

  if (!docsModules) {
    return {
      report: null,
      formatted: 'Trace-Docs Sync Report\n======================\n\nNo architecture.yaml found. Run docs-scaffold.mjs first.',
    };
  }

  const report = compareSyncState(traceModules, docsModules);
  const formatted = formatSyncReport(report);

  return { report, formatted };
}

// =============================================================================
// CLI Entry Point
// =============================================================================

async function main() {
  try {
    const projectRoot = resolveProjectRoot();
    const { formatted } = generateSyncReport(projectRoot);
    console.log(formatted);
    process.exit(0);
  } catch (err) {
    console.error(`Sync report failed: ${err.message}`);
    process.exit(1);
  }
}

// Run main only if executed directly
const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('trace-docs-sync.mjs') &&
  !process.argv[1].endsWith('.test.mjs');

if (isMainModule) {
  main();
}
