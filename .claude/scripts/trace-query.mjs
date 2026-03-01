#!/usr/bin/env node

/**
 * Trace Query Helper Script
 *
 * Provides agent-friendly trace querying for impact analysis and dependency discovery.
 * Agents use this script before making changes to understand upstream/downstream impact.
 *
 * Usage:
 *   node .claude/scripts/trace-query.mjs --module <id>           # Show module's upstream/downstream deps
 *   node .claude/scripts/trace-query.mjs --module <id> --detail  # Also show low-level file/function details
 *   node .claude/scripts/trace-query.mjs --impact <file-path>    # Show what modules are affected by changing this file
 *
 * Implements: REQ-AT-023, REQ-AT-024
 * Spec: as-014-agent-consumption
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadTraceConfig,
  fileToModule,
  resolveProjectRoot,
  HIGH_LEVEL_TRACE_PATH,
  LOW_LEVEL_TRACE_DIR,
} from './lib/trace-utils.mjs';

// =============================================================================
// Constants
// =============================================================================

const EXIT_SUCCESS = 0;
const EXIT_USAGE_ERROR = 1;
const EXIT_NOT_FOUND = 2;

// =============================================================================
// High-Level Trace Loading
// =============================================================================

/**
 * Load the high-level trace JSON from disk.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {object} Parsed high-level trace
 * @throws {Error} If trace file is missing or malformed
 */
function loadHighLevelTrace(projectRoot) {
  const tracePath = join(projectRoot, HIGH_LEVEL_TRACE_PATH);

  if (!existsSync(tracePath)) {
    throw new Error(
      `High-level trace not found at ${tracePath}. Run 'node .claude/scripts/trace-generate.mjs' first.`,
    );
  }

  const raw = readFileSync(tracePath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Load a low-level trace JSON for a specific module.
 *
 * @param {string} moduleId - Module identifier
 * @param {string} projectRoot - Absolute path to project root
 * @returns {object | null} Parsed low-level trace or null if not found
 */
function loadLowLevelTrace(moduleId, projectRoot) {
  const tracePath = join(projectRoot, LOW_LEVEL_TRACE_DIR, `${moduleId}.json`);

  if (!existsSync(tracePath)) {
    return null;
  }

  try {
    const raw = readFileSync(tracePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// =============================================================================
// Module Query (AC-14.1: upstream dependencies and downstream dependents)
// =============================================================================

/**
 * Query a module's dependencies and dependents from the high-level trace.
 *
 * AC-14.1: Agent can identify all direct upstream dependencies and
 * direct downstream dependents from the structured sections.
 *
 * @param {string} moduleId - Module to query
 * @param {object} highLevelTrace - Parsed high-level trace
 * @returns {{ module: object, dependencies: Array, dependents: Array } | null}
 */
function queryModule(moduleId, highLevelTrace) {
  const mod = highLevelTrace.modules.find(m => m.id === moduleId);
  if (!mod) {
    return null;
  }

  return {
    module: mod,
    dependencies: mod.dependencies || [],
    dependents: mod.dependents || [],
  };
}

/**
 * Format a module query result as agent-friendly markdown.
 *
 * @param {object} queryResult - Result from queryModule
 * @param {boolean} includeDetail - Whether to include low-level file details
 * @param {string} projectRoot - Project root for loading low-level trace
 * @returns {string} Markdown-formatted output
 */
function formatModuleQuery(queryResult, includeDetail, projectRoot) {
  const { module: mod, dependencies, dependents } = queryResult;
  const lines = [];

  lines.push(`# Module: ${mod.name} (${mod.id})`);
  lines.push('');
  lines.push(`**Description**: ${mod.description || '(none)'}`);
  lines.push(`**File Globs**: ${mod.fileGlobs.map(g => '`' + g + '`').join(', ')}`);
  lines.push('');

  // Upstream dependencies (what this module depends on)
  lines.push('## Upstream Dependencies (this module depends on)');
  lines.push('');
  if (dependencies.length > 0) {
    lines.push('| Target | Relationship | Description |');
    lines.push('|--------|-------------|-------------|');
    for (const dep of dependencies) {
      lines.push(`| ${dep.targetId} | ${dep.relationshipType} | ${dep.description} |`);
    }
  } else {
    lines.push('No upstream dependencies.');
  }
  lines.push('');

  // Downstream dependents (what depends on this module)
  lines.push('## Downstream Dependents (depends on this module)');
  lines.push('');
  if (dependents.length > 0) {
    lines.push('| Target | Relationship | Description |');
    lines.push('|--------|-------------|-------------|');
    for (const dep of dependents) {
      lines.push(`| ${dep.targetId} | ${dep.relationshipType} | ${dep.description} |`);
    }
  } else {
    lines.push('No downstream dependents.');
  }
  lines.push('');

  // AC-14.2 + AC-14.3: Drill down to low-level detail
  if (includeDetail) {
    const lowLevel = loadLowLevelTrace(mod.id, projectRoot);

    lines.push('## File-Level Detail');
    lines.push('');

    if (lowLevel && lowLevel.files && lowLevel.files.length > 0) {
      lines.push(`*${lowLevel.files.length} files in module (v${lowLevel.version}, generated ${lowLevel.lastGenerated})*`);
      lines.push('');

      for (const file of lowLevel.files) {
        lines.push(`### ${file.filePath}`);
        lines.push('');

        // Exports
        if (file.exports.length > 0) {
          lines.push('**Exports**: ' + file.exports.map(e => `\`${e.symbol}\` (${e.type})`).join(', '));
        }

        // Imports
        if (file.imports.length > 0) {
          lines.push('**Imports**: ' + file.imports.map(i => {
            const syms = i.symbols.length > 0 ? i.symbols.join(', ') : '(side-effect)';
            return `\`${i.source}\` [${syms}]`;
          }).join(', '));
        }

        // Function calls
        if (file.calls.length > 0) {
          lines.push('**Calls**: ' + file.calls.map(c => `\`${c.target}:${c.function}\``).join(', '));
        }

        // Events
        if (file.events.length > 0) {
          lines.push('**Events**: ' + file.events.map(e => `${e.type} \`${e.eventName}\` on \`${e.channel}\``).join(', '));
        }

        lines.push('');
      }
    } else {
      lines.push('No low-level trace available. Run `node .claude/scripts/trace-generate.mjs` to generate.');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// =============================================================================
// Impact Analysis (identifies affected modules for a file change)
// =============================================================================

/**
 * Analyze the impact of changing a specific file.
 *
 * Determines which module owns the file, then reports:
 * - The owning module and its dependents (modules that would be affected)
 * - Cross-module imports of the file's exports
 *
 * @param {string} filePath - Relative file path from project root
 * @param {object} config - Trace config
 * @param {object} highLevelTrace - Parsed high-level trace
 * @param {string} projectRoot - Project root
 * @returns {{ owningModule: object | null, affectedModules: Array<{ id: string, name: string, reason: string }>, fileDetail: object | null }}
 */
function analyzeImpact(filePath, config, highLevelTrace, projectRoot) {
  const owningModule = fileToModule(filePath, config);

  if (!owningModule) {
    return {
      owningModule: null,
      affectedModules: [],
      fileDetail: null,
    };
  }

  // Find the module in high-level trace for its dependents
  const hlModule = highLevelTrace.modules.find(m => m.id === owningModule.id);
  const dependents = hlModule ? (hlModule.dependents || []) : [];

  // Build affected modules list from dependents
  const affectedModules = dependents.map(dep => ({
    id: dep.targetId,
    name: highLevelTrace.modules.find(m => m.id === dep.targetId)?.name || dep.targetId,
    reason: `${dep.relationshipType}: ${dep.description}`,
  }));

  // Load low-level trace to find the specific file's exports
  let fileDetail = null;
  const lowLevel = loadLowLevelTrace(owningModule.id, projectRoot);
  if (lowLevel && lowLevel.files) {
    fileDetail = lowLevel.files.find(f => f.filePath === filePath) || null;
  }

  return {
    owningModule,
    affectedModules,
    fileDetail,
  };
}

/**
 * Format impact analysis result as agent-friendly markdown.
 *
 * @param {string} filePath - The file being analyzed
 * @param {object} impactResult - Result from analyzeImpact
 * @returns {string} Markdown-formatted output
 */
function formatImpactAnalysis(filePath, impactResult) {
  const { owningModule, affectedModules, fileDetail } = impactResult;
  const lines = [];

  lines.push(`# Impact Analysis: ${filePath}`);
  lines.push('');

  if (!owningModule) {
    lines.push('**Status**: Untraced file (no module owns this file)');
    lines.push('');
    lines.push('This file is not covered by any module in `trace.config.json`.');
    lines.push('Changes to this file have unknown impact scope.');
    return lines.join('\n');
  }

  lines.push(`**Owning Module**: ${owningModule.name} (\`${owningModule.id}\`)`);
  lines.push('');

  // Affected modules (downstream dependents)
  lines.push('## Affected Modules');
  lines.push('');
  if (affectedModules.length > 0) {
    lines.push('Changes to this file may affect:');
    lines.push('');
    lines.push('| Module | Reason |');
    lines.push('|--------|--------|');
    for (const affected of affectedModules) {
      lines.push(`| ${affected.name} (\`${affected.id}\`) | ${affected.reason} |`);
    }
  } else {
    lines.push('No downstream modules depend on this module.');
  }
  lines.push('');

  // File-level detail from low-level trace
  if (fileDetail) {
    lines.push('## File Detail');
    lines.push('');

    if (fileDetail.exports.length > 0) {
      lines.push('**Exported symbols** (changes here propagate to consumers):');
      lines.push('');
      for (const exp of fileDetail.exports) {
        lines.push(`- \`${exp.symbol}\` (${exp.type})`);
      }
      lines.push('');
    }

    if (fileDetail.imports.length > 0) {
      lines.push('**Dependencies** (this file depends on):');
      lines.push('');
      for (const imp of fileDetail.imports) {
        const syms = imp.symbols.length > 0 ? imp.symbols.join(', ') : '(side-effect)';
        lines.push(`- \`${imp.source}\`: ${syms}`);
      }
      lines.push('');
    }

    if (fileDetail.events.length > 0) {
      lines.push('**Events**:');
      lines.push('');
      for (const evt of fileDetail.events) {
        lines.push(`- ${evt.type} \`${evt.eventName}\` on \`${evt.channel}\``);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// =============================================================================
// CLI
// =============================================================================

function printUsage() {
  console.log(`Usage:
  node .claude/scripts/trace-query.mjs --module <id>           Show module dependencies
  node .claude/scripts/trace-query.mjs --module <id> --detail  Include file-level detail
  node .claude/scripts/trace-query.mjs --impact <file-path>    Show impact of changing a file

Options:
  --module <id>    Module ID to query (from trace.config.json)
  --detail         Include low-level file/function details (with --module)
  --impact <path>  File path to analyze for impact (relative to project root)
  --help           Show this help message`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    mode: null,
    moduleId: null,
    filePath: null,
    detail: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--module':
        result.mode = 'module';
        result.moduleId = args[++i];
        break;
      case '--impact':
        result.mode = 'impact';
        result.filePath = args[++i];
        break;
      case '--detail':
        result.detail = true;
        break;
      case '--help':
      case '-h':
        result.mode = 'help';
        break;
      default:
        // Unknown argument
        break;
    }
  }

  return result;
}

function main() {
  const args = parseArgs(process.argv);

  if (args.mode === 'help' || args.mode === null) {
    printUsage();
    process.exit(args.mode === 'help' ? EXIT_SUCCESS : EXIT_USAGE_ERROR);
  }

  try {
    const projectRoot = resolveProjectRoot();
    const config = loadTraceConfig(projectRoot);
    const highLevelTrace = loadHighLevelTrace(projectRoot);

    if (args.mode === 'module') {
      if (!args.moduleId) {
        console.error('Error: --module requires a module ID.');
        printUsage();
        process.exit(EXIT_USAGE_ERROR);
      }

      const result = queryModule(args.moduleId, highLevelTrace);
      if (!result) {
        console.error(`Error: Module "${args.moduleId}" not found in trace.`);
        console.error('Available modules:');
        for (const mod of highLevelTrace.modules) {
          console.error(`  - ${mod.id} (${mod.name})`);
        }
        process.exit(EXIT_NOT_FOUND);
      }

      console.log(formatModuleQuery(result, args.detail, projectRoot));
      process.exit(EXIT_SUCCESS);
    }

    if (args.mode === 'impact') {
      if (!args.filePath) {
        console.error('Error: --impact requires a file path.');
        printUsage();
        process.exit(EXIT_USAGE_ERROR);
      }

      const result = analyzeImpact(args.filePath, config, highLevelTrace, projectRoot);
      console.log(formatImpactAnalysis(args.filePath, result));
      process.exit(EXIT_SUCCESS);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(EXIT_USAGE_ERROR);
  }
}

// Export functions for testing
export {
  loadHighLevelTrace,
  loadLowLevelTrace,
  queryModule,
  formatModuleQuery,
  analyzeImpact,
  formatImpactAnalysis,
  parseArgs,
};

// Run main only if executed directly
const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('trace-query.mjs') &&
  !process.argv[1].endsWith('.test.mjs');

if (isMainModule) {
  main();
}
