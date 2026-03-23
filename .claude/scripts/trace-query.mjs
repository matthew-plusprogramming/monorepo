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
import { join, resolve } from 'node:path';
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

        // Function calls (M1: updated to use contract-calls-events-schema field names)
        if (file.calls.length > 0) {
          lines.push('**Calls**: ' + file.calls.map(c => {
            const target = c.calleeFile ? `${c.calleeFile}:${c.calleeLine || '?'}` : '(unresolved)';
            return `\`${c.calleeName}\` -> ${target}`;
          }).join(', '));
        }

        // Events (M1: updated to use contract-calls-events-schema field names)
        if (file.events.length > 0) {
          lines.push('**Events**: ' + file.events.map(e => `${e.type} \`${e.eventName}\``).join(', '));
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
        lines.push(`- ${evt.type} \`${evt.eventName}\` at ${evt.file}:${evt.line}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// =============================================================================
// Call Graph Query (REQ-004: --calls mode)
// =============================================================================

/**
 * Query callers and callees of a function across all traced modules.
 *
 * Searches all low-level trace JSON files for matching entries in calls[] arrays.
 * Returns a complete cross-module view showing all callers/callees with module context.
 *
 * Implements: contract-trace-query-calls-cli
 *
 * @param {string} functionName - Function name to search for
 * @param {string} projectRoot - Absolute path to project root
 * @returns {{ callers: Array<{ moduleId: string, callerFile: string, callerLine: number, calleeName: string }>, callees: Array<{ moduleId: string, callerFile: string, callerLine: number, calleeName: string, calleeFile: string|null, calleeLine: number|null }> }}
 */
function queryCallGraph(functionName, projectRoot) {
  const config = loadTraceConfig(projectRoot);
  const callers = [];
  const callees = [];

  for (const mod of config.modules) {
    const lowLevel = loadLowLevelTrace(mod.id, projectRoot);
    if (!lowLevel || !lowLevel.files) continue;

    for (const file of lowLevel.files) {
      if (!Array.isArray(file.calls)) continue;

      for (const call of file.calls) {
        // Find callers: entries where calleeName matches the function
        if (call.calleeName === functionName) {
          callers.push({
            moduleId: mod.id,
            callerFile: call.callerFile,
            callerLine: call.callerLine,
            calleeName: call.calleeName,
          });
        }

        // Find callees: entries in files that export the function
        // (i.e., the function is a caller and we want to know what it calls)
        // Check if this call originates from the function we're querying
        // We approximate this by checking if the callerFile exports the functionName
      }

      // Find callees: look for calls made FROM files that export this function
      const exportsFunction = file.exports && file.exports.some(e => e.symbol === functionName);
      if (exportsFunction) {
        for (const call of file.calls) {
          callees.push({
            moduleId: mod.id,
            callerFile: call.callerFile,
            callerLine: call.callerLine,
            calleeName: call.calleeName,
            calleeFile: call.calleeFile,
            calleeLine: call.calleeLine,
          });
        }
      }
    }
  }

  return { callers, callees };
}

/**
 * Format call graph query results as CLI output.
 *
 * Follows existing CLI conventions established by --module and --impact modes.
 *
 * @param {string} functionName - Function that was queried
 * @param {{ callers: Array, callees: Array }} result - Query results
 * @returns {string} Formatted output
 */
function formatCallGraphQuery(functionName, result) {
  const lines = [];

  lines.push(`Callers of ${functionName}:`);
  if (result.callers.length > 0) {
    for (const caller of result.callers) {
      lines.push(`  ${caller.moduleId} / ${caller.callerFile}:${caller.callerLine}`);
    }
  } else {
    lines.push('  (none found)');
  }

  lines.push('');
  lines.push(`Callees of ${functionName}:`);
  if (result.callees.length > 0) {
    for (const callee of result.callees) {
      const target = callee.calleeFile ? `${callee.calleeFile}:${callee.calleeLine || '?'}` : '(unresolved)';
      lines.push(`  ${callee.moduleId} / ${callee.callerFile}:${callee.callerLine} - ${callee.calleeName} -> ${target}`);
    }
  } else {
    lines.push('  (none found)');
  }

  return lines.join('\n');
}

// =============================================================================
// Path Traversal Validation (REQ-031)
// =============================================================================

/**
 * Validate and sanitize a file path input.
 *
 * Resolves the path against projectRoot and validates it stays within
 * the project boundary. Rejects paths with .. traversal that escape.
 *
 * @param {string} inputPath - Raw file path from user input
 * @param {string} projectRoot - Absolute path to project root
 * @returns {string} Resolved, validated path within projectRoot
 * @throws {Error} If path escapes project boundary
 */
function validateFilePath(inputPath, projectRoot) {
  const resolved = resolve(projectRoot, inputPath);
  if (!resolved.startsWith(projectRoot)) {
    throw new Error(`Path traversal rejected: ${inputPath} resolves outside project root`);
  }
  return resolved;
}

// =============================================================================
// CLI
// =============================================================================

function printUsage() {
  console.log(`Usage:
  node .claude/scripts/trace-query.mjs --module <id>           Show module dependencies
  node .claude/scripts/trace-query.mjs --module <id> --detail  Include file-level detail
  node .claude/scripts/trace-query.mjs --impact <file-path>    Show impact of changing a file
  node .claude/scripts/trace-query.mjs --calls <functionName>  Show callers/callees of a function

Options:
  --module <id>    Module ID to query (from trace.config.json)
  --detail         Include low-level file/function details (with --module)
  --impact <path>  File path to analyze for impact (relative to project root)
  --calls <name>   Function name to query for callers and callees
  --help           Show this help message`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    mode: null,
    moduleId: null,
    filePath: null,
    functionName: null,
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
      case '--calls':
        result.mode = 'calls';
        result.functionName = args[++i];
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

      // Validate path stays within project boundary (rejects .. traversal escapes)
      validateFilePath(args.filePath, projectRoot);
      const result = analyzeImpact(args.filePath, config, highLevelTrace, projectRoot);
      console.log(formatImpactAnalysis(args.filePath, result));
      process.exit(EXIT_SUCCESS);
    }

    if (args.mode === 'calls') {
      if (!args.functionName) {
        console.error('Error: --calls requires a function name.');
        printUsage();
        process.exit(EXIT_USAGE_ERROR);
      }

      const result = queryCallGraph(args.functionName, projectRoot);
      console.log(formatCallGraphQuery(args.functionName, result));
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
  queryCallGraph,
  formatCallGraphQuery,
  validateFilePath,
};

// Run main only if executed directly
const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('trace-query.mjs') &&
  !process.argv[1].endsWith('.test.mjs');

if (isMainModule) {
  main();
}
