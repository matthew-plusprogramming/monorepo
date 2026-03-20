#!/usr/bin/env node

/**
 * Trace Generation Script
 *
 * Generates low-level trace files for each module defined in trace.config.json.
 * For each module, scans files matching the module's fileGlobs and produces:
 *   - .claude/traces/low-level/<module-id>.json (canonical data)
 *   - .claude/traces/low-level/<module-id>.md (generated markdown view)
 *
 * Each file entry contains: filePath, exports, imports, calls, events.
 * In v1, calls and events arrays are empty (manual population deferred).
 * Imports and exports are extracted via static analysis of import/export statements.
 *
 * Usage:
 *   node .claude/scripts/trace-generate.mjs                  # Generate all traces (high-level + low-level)
 *   node .claude/scripts/trace-generate.mjs <module-id>      # Generate single module (low-level + high-level update)
 *   node .claude/scripts/trace-generate.mjs --low-level-only # Skip high-level trace
 *   node .claude/scripts/trace-generate.mjs --bootstrap      # Auto-detect modules and generate starter config
 *
 * Implements: REQ-AT-004, REQ-AT-005, REQ-AT-006, REQ-AT-008, REQ-AT-009, REQ-AT-011
 * Spec: as-004-low-level-trace, as-005-trace-generate-command, as-013-trace-bootstrap
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

import {
  loadTraceConfig,
  findFilesMatchingGlobs,
  fileToModules,
  resolveProjectRoot,
  formatTimestamp,
  sanitizeMarkdown,
  LOW_LEVEL_TRACE_DIR,
} from './lib/trace-utils.mjs';

import {
  generateHighLevelTrace,
} from './lib/high-level-trace.mjs';

// =============================================================================
// Constants
// =============================================================================

const GENERATED_BY = 'trace-generate';

// =============================================================================
// Import/Export Static Analysis
// =============================================================================

/**
 * Parse import statements from TypeScript/JavaScript source code.
 *
 * Handles:
 * - import { X, Y } from 'source'
 * - import X from 'source'
 * - import * as X from 'source'
 * - import type { X } from 'source'
 * - import 'source' (side-effect)
 * - const X = require('source')
 *
 * @param {string} source - File source code
 * @returns {Array<{ source: string, symbols: string[] }>}
 */
export function parseImports(source) {
  const imports = [];

  // Remove block comments to avoid false positives
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, '');

  const lines = cleaned.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip single-line comments
    if (line.startsWith('//')) {
      i++;
      continue;
    }

    // Match: import { ... } from '...' (possibly multiline)
    // Match: import X from '...'
    // Match: import * as X from '...'
    // Match: import type { ... } from '...'
    // Match: import '...' (side-effect)
    const importMatch = line.match(/^import\s+/);
    if (importMatch) {
      // Collect the full import statement (may span multiple lines)
      let fullStatement = line;
      const importStartLine = i;
      while (i < lines.length - 1 && !fullStatement.includes(';') && !fullStatement.match(/from\s+['"][^'"]+['"]/) && (i - importStartLine) < MULTI_LINE_IMPORT_BUFFER_LIMIT) {
        i++;
        fullStatement += ' ' + lines[i].trim();
      }

      const parsed = parseImportStatement(fullStatement);
      if (parsed) {
        imports.push(parsed);
      }
    }

    // Match: const X = require('...')
    const requireMatch = line.match(/(?:const|let|var)\s+(?:\{[^}]+\}|\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch) {
      const source = requireMatch[1];
      // Extract destructured symbols or default name
      const symbolsMatch = line.match(/(?:const|let|var)\s+\{([^}]+)\}/);
      const defaultMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=/);
      const symbols = symbolsMatch
        ? symbolsMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean)
        : defaultMatch ? [defaultMatch[1]] : [];
      imports.push({ source, symbols });
    }

    i++;
  }

  return imports;
}

/**
 * Parse a single import statement into source and symbols.
 *
 * @param {string} statement - Full import statement text
 * @returns {{ source: string, symbols: string[] } | null}
 */
function parseImportStatement(statement) {
  // Side-effect import: import 'source'
  const sideEffectMatch = statement.match(/^import\s+['"]([^'"]+)['"]/);
  if (sideEffectMatch) {
    return { source: sideEffectMatch[1], symbols: [] };
  }

  // Extract the source (from '...' or from "...")
  const sourceMatch = statement.match(/from\s+['"]([^'"]+)['"]/);
  if (!sourceMatch) {
    return null;
  }
  const source = sourceMatch[1];

  // Remove 'import' keyword and 'type' keyword for type imports
  let importPart = statement
    .replace(/^import\s+/, '')
    .replace(/^type\s+/, '');

  // Remove the from clause
  importPart = importPart.replace(/\s*from\s+['"][^'"]+['"].*$/, '').trim();

  const symbols = [];

  // Namespace import: * as X
  const namespaceMatch = importPart.match(/^\*\s+as\s+(\w+)/);
  if (namespaceMatch) {
    symbols.push(`* as ${namespaceMatch[1]}`);
    return { source, symbols };
  }

  // Default import with named: X, { Y, Z }
  const defaultAndNamedMatch = importPart.match(/^(\w+)\s*,\s*\{([^}]+)\}/);
  if (defaultAndNamedMatch) {
    symbols.push(defaultAndNamedMatch[1]);
    const named = defaultAndNamedMatch[2].split(',').map(s => {
      const parts = s.trim().split(/\s+as\s+/);
      return parts.length > 1 ? parts[1].trim() : parts[0].trim();
    }).filter(Boolean);
    symbols.push(...named);
    return { source, symbols };
  }

  // Named imports: { X, Y, Z }
  const namedMatch = importPart.match(/^\{([^}]+)\}/);
  if (namedMatch) {
    const named = namedMatch[1].split(',').map(s => {
      const parts = s.trim().split(/\s+as\s+/);
      return parts.length > 1 ? parts[1].trim() : parts[0].trim();
    }).filter(Boolean);
    symbols.push(...named);
    return { source, symbols };
  }

  // Default import: X
  const defaultMatch = importPart.match(/^(\w+)$/);
  if (defaultMatch) {
    symbols.push(defaultMatch[1]);
    return { source, symbols };
  }

  // Fallback: return source with empty symbols
  return { source, symbols };
}

// =============================================================================
// Signature Capture Constants
// =============================================================================

/** Maximum length for display-facing signature field */
const SIGNATURE_DISPLAY_MAX_LENGTH = 200;

/** Maximum length for raw signature field (hard cap) */
const SIGNATURE_RAW_MAX_LENGTH = 500;

/** Maximum number of additional lines to buffer for multi-line signatures */
const MULTI_LINE_SIGNATURE_BUFFER_LIMIT = 5;

/** Maximum number of additional lines to buffer for multi-line import/re-export collectors */
const MULTI_LINE_IMPORT_BUFFER_LIMIT = 20;

/**
 * Truncate a string to maxLen characters, appending '...' suffix if exceeded.
 *
 * @param {string} text - Input text
 * @param {number} maxLen - Maximum length before truncation
 * @returns {string} Original or truncated text
 */
function truncateWithEllipsis(text, maxLen) {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen) + '...';
}

/**
 * Remove block comments from source while preserving line count.
 *
 * Replaces block comment content with equivalent newlines so that
 * line numbers in the cleaned source correspond to the original source.
 *
 * @param {string} source - Raw source code
 * @returns {string} Source with block comments replaced by newlines
 */
function removeBlockCommentsPreserveLines(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    // Count newlines in the matched comment and produce that many newlines
    const newlineCount = (match.match(/\n/g) || []).length;
    return '\n'.repeat(newlineCount);
  });
}

/**
 * Capture function signature from an export line and subsequent lines.
 *
 * Extracts the text from the first `(` through the balanced closing `)`,
 * plus any return type annotation (`: ReturnType`).
 *
 * For multi-line signatures, buffers up to MULTI_LINE_SIGNATURE_BUFFER_LIMIT
 * additional lines until parentheses balance.
 *
 * @param {string} line - The export declaration line (trimmed)
 * @param {string[]} allLines - All source lines (trimmed)
 * @param {number} lineIndex - Index of current line in allLines
 * @returns {{ signature: string, signatureRaw: string, linesConsumed: number }}
 */
function captureSignature(line, allLines, lineIndex) {
  // Find the opening parenthesis
  const parenIndex = line.indexOf('(');
  if (parenIndex === -1) {
    // No parenthesis found -- not a function-like export
    return { signature: '', signatureRaw: '', linesConsumed: 0 };
  }

  // Assemble text starting from the opening paren
  let assembled = line.slice(parenIndex);
  let depth = 0;
  let balanced = false;
  let linesConsumed = 0;

  // Count parens in assembled text
  for (const ch of assembled) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0) {
      balanced = true;
      break;
    }
  }

  // If not balanced, buffer subsequent lines
  if (!balanced) {
    for (let extra = 1; extra <= MULTI_LINE_SIGNATURE_BUFFER_LIMIT; extra++) {
      const nextIdx = lineIndex + extra;
      if (nextIdx >= allLines.length) break;
      assembled += ' ' + allLines[nextIdx].trim();
      linesConsumed = extra;

      // Re-check balance
      depth = 0;
      balanced = false;
      for (const ch of assembled) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (depth === 0) {
          balanced = true;
          break;
        }
      }
      if (balanced) break;
    }
  }

  if (!balanced) {
    // 5-line limit reached without balance -- store as unparseable in signatureRaw
    const rawText = truncateWithEllipsis(assembled.replace(/\s+/g, ' ').trim(), SIGNATURE_RAW_MAX_LENGTH);
    return { signature: '', signatureRaw: rawText, linesConsumed };
  }

  // Find the position of the balanced closing paren
  let sigEnd = -1;
  depth = 0;
  for (let k = 0; k < assembled.length; k++) {
    if (assembled[k] === '(') depth++;
    if (assembled[k] === ')') depth--;
    if (depth === 0) {
      sigEnd = k;
      break;
    }
  }

  // Extract from '(' to ')' inclusive, plus any return type
  let sigText = assembled.slice(0, sigEnd + 1);

  // Capture return type: look for ': <type>' after the closing paren
  const afterParen = assembled.slice(sigEnd + 1).trim();
  const returnTypeMatch = afterParen.match(/^:\s*([^{;=]+)/);
  if (returnTypeMatch) {
    sigText += ': ' + returnTypeMatch[1].trim();
  }

  // Collapse whitespace for display
  const collapsed = sigText.replace(/\s+/g, ' ').trim();

  const signatureRaw = truncateWithEllipsis(collapsed, SIGNATURE_RAW_MAX_LENGTH);
  const signature = truncateWithEllipsis(collapsed, SIGNATURE_DISPLAY_MAX_LENGTH);

  return { signature, signatureRaw, linesConsumed };
}

/**
 * Parse export statements from TypeScript/JavaScript source code.
 *
 * Handles:
 * - export function name() {}
 * - export async function name() {}
 * - export class Name {}
 * - export interface Name {}
 * - export type Name = ...
 * - export const/let/var name = ...
 * - export enum Name {}
 * - export default ...
 * - export { X, Y } from '...'
 * - export { X, Y }
 *
 * Enhanced fields (additive optional properties):
 * - lineNumber: 1-indexed source line number of the export declaration
 * - signature: Display-facing function signature, truncated at 200 chars
 * - signatureRaw: Extended capture, hard cap at 500 chars
 *
 * @param {string} source - File source code
 * @returns {Array<{ symbol: string, type: string, lineNumber: number, signature: string, signatureRaw: string }>}
 */
export function parseExports(source) {
  const exports = [];
  const seen = new Set();

  // Remove block comments while preserving line numbers
  const cleaned = removeBlockCommentsPreserveLines(source);

  const lines = cleaned.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // 1-indexed line number
    const lineNumber = i + 1;

    // Skip single-line comments
    if (line.startsWith('//')) {
      continue;
    }

    // export default
    if (line.match(/^export\s+default\s+/)) {
      // export default class Name / function name / expression
      const classMatch = line.match(/^export\s+default\s+class\s+(\w+)/);
      const funcMatch = line.match(/^export\s+default\s+(?:async\s+)?function\s+(\w+)/);
      const symbol = classMatch ? classMatch[1]
        : funcMatch ? funcMatch[1]
          : 'default';

      let signature = '';
      let signatureRaw = '';
      if (funcMatch) {
        const sigResult = captureSignature(line, lines, i);
        signature = sigResult.signature;
        signatureRaw = sigResult.signatureRaw;
      }

      if (!seen.has('default')) {
        seen.add('default');
        exports.push({ symbol, type: 'default', lineNumber, signature, signatureRaw });
      }
      continue;
    }

    // export { X, Y } or export { X, Y } from '...'
    // May span multiple lines
    const reExportMatch = line.match(/^export\s+(?:type\s+)?\{/);
    if (reExportMatch) {
      let fullStatement = line;
      const reExportStartLine = i;
      while (i < lines.length - 1 && !fullStatement.includes('}') && (i - reExportStartLine) < MULTI_LINE_IMPORT_BUFFER_LIMIT) {
        i++;
        fullStatement += ' ' + lines[i].trim();
      }

      const bracketContent = fullStatement.match(/\{([^}]+)\}/);
      if (bracketContent) {
        const symbols = bracketContent[1].split(',').map(s => {
          const parts = s.trim().split(/\s+as\s+/);
          return parts.length > 1 ? parts[1].trim() : parts[0].trim();
        }).filter(Boolean);

        // Determine type: if 'export type {' then type, else const
        const isTypeExport = fullStatement.match(/^export\s+type\s+\{/);
        for (const sym of symbols) {
          if (!seen.has(sym)) {
            seen.add(sym);
            exports.push({ symbol: sym, type: isTypeExport ? 'type' : 'const', lineNumber, signature: '', signatureRaw: '' });
          }
        }
      }
      continue;
    }

    // export function name (including overloads)
    const funcMatch = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    if (funcMatch) {
      const symbol = funcMatch[1];
      const sigResult = captureSignature(line, lines, i);

      // Support overloaded functions (REQ-004): allow multiple entries for the same
      // symbol when they have different signatures (overload declarations).
      // An overload declaration line typically ends with ';' (no body).
      const isOverloadDecl = /;\s*$/.test(line);

      if (isOverloadDecl || !seen.has(symbol)) {
        if (!isOverloadDecl) {
          seen.add(symbol);
        }
        exports.push({
          symbol,
          type: 'function',
          lineNumber,
          signature: sigResult.signature,
          signatureRaw: sigResult.signatureRaw,
        });
      }
      continue;
    }

    // export class Name
    const classMatch = line.match(/^export\s+class\s+(\w+)/);
    if (classMatch) {
      const symbol = classMatch[1];
      if (!seen.has(symbol)) {
        seen.add(symbol);
        exports.push({ symbol, type: 'class', lineNumber, signature: '', signatureRaw: '' });
      }
      continue;
    }

    // export interface Name
    const interfaceMatch = line.match(/^export\s+interface\s+(\w+)/);
    if (interfaceMatch) {
      const symbol = interfaceMatch[1];
      if (!seen.has(symbol)) {
        seen.add(symbol);
        exports.push({ symbol, type: 'interface', lineNumber, signature: '', signatureRaw: '' });
      }
      continue;
    }

    // export type Name = ...
    const typeMatch = line.match(/^export\s+type\s+(\w+)\s*[=<]/);
    if (typeMatch) {
      const symbol = typeMatch[1];
      if (!seen.has(symbol)) {
        seen.add(symbol);
        exports.push({ symbol, type: 'type', lineNumber, signature: '', signatureRaw: '' });
      }
      continue;
    }

    // export enum Name
    const enumMatch = line.match(/^export\s+enum\s+(\w+)/);
    if (enumMatch) {
      const symbol = enumMatch[1];
      if (!seen.has(symbol)) {
        seen.add(symbol);
        exports.push({ symbol, type: 'enum', lineNumber, signature: '', signatureRaw: '' });
      }
      continue;
    }

    // export const/let/var name
    // Also handles: export const Name = z.enum(...)
    const constMatch = line.match(/^export\s+(?:const|let|var)\s+(\w+)/);
    if (constMatch) {
      const symbol = constMatch[1];
      if (!seen.has(symbol)) {
        seen.add(symbol);
        exports.push({ symbol, type: 'const', lineNumber, signature: '', signatureRaw: '' });
      }
      continue;
    }
  }

  return exports;
}

// =============================================================================
// Low-Level Trace Generation
// =============================================================================

/**
 * Analyze a single file for imports and exports.
 *
 * @param {string} filePath - Relative path from project root
 * @param {string} projectRoot - Absolute project root path
 * @returns {{ filePath: string, exports: Array, imports: Array, calls: Array, events: Array }}
 */
export function analyzeFile(filePath, projectRoot) {
  const absPath = join(projectRoot, filePath);

  // Default entry with empty arrays
  const entry = {
    filePath,
    exports: [],
    imports: [],
    calls: [],    // v1: empty, manual population deferred
    events: [],   // v1: empty, manual population deferred
  };

  // Only analyze TS/JS files
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) {
    return entry;
  }

  try {
    const source = readFileSync(absPath, 'utf-8');
    entry.exports = parseExports(source);
    entry.imports = parseImports(source);
  } catch (err) {
    // File read failure: return entry with empty arrays
    // This can happen for binary files or permission issues
  }

  return entry;
}

/**
 * Generate a low-level trace for a single module.
 *
 * Scans all files matching the module's fileGlobs, analyzes each for
 * imports/exports, and produces the LowLevelTrace data structure.
 *
 * AC-3.1: JSON validates against LowLevelTrace schema
 * AC-3.3: Each file in module's glob scope has an entry
 *
 * @param {{ id: string, name: string, description?: string, fileGlobs: string[] }} moduleConfig
 * @param {{ version: number, modules: Array }} traceConfig - Full trace config
 * @param {string} projectRoot - Absolute project root
 * @returns {{ moduleId: string, version: number, lastGenerated: string, generatedBy: string, files: Array }}
 */
export function generateLowLevelTrace(moduleConfig, traceConfig, projectRoot) {
  // Find all files matching the module's globs
  const matchingFiles = findFilesMatchingGlobs(moduleConfig.fileGlobs, projectRoot);

  // Sort files for deterministic output
  matchingFiles.sort();

  // Read existing trace to get current version for incrementing
  let currentVersion = 0;
  const tracePath = join(projectRoot, LOW_LEVEL_TRACE_DIR, `${moduleConfig.id}.json`);
  try {
    const existing = JSON.parse(readFileSync(tracePath, 'utf-8'));
    if (typeof existing.version === 'number') {
      currentVersion = existing.version;
    }
  } catch {
    // No existing trace or invalid - start at version 0 (will become 1)
  }

  // AC-3.3: Analyze each file in the module's glob scope
  const files = matchingFiles.map(filePath => analyzeFile(filePath, projectRoot));

  // AC-3.1: Build LowLevelTrace data structure
  return {
    moduleId: moduleConfig.id,
    version: currentVersion + 1,
    lastGenerated: formatTimestamp(),
    generatedBy: GENERATED_BY,
    files,
  };
}

/**
 * Generate markdown from a low-level trace JSON object.
 *
 * AC-3.2: Structured sections (Exports, Imports, Function Calls, Events)
 * with pipe-delimited format and HTML comment metadata.
 *
 * @param {{ moduleId: string, version: number, lastGenerated: string, generatedBy: string, files: Array }} trace
 * @param {{ id: string, name: string }} moduleConfig
 * @returns {string} Markdown content
 */
export function generateLowLevelMarkdown(trace, moduleConfig) {
  const lines = [];

  // HTML comment metadata (AC-3.2)
  lines.push(`<!-- trace-id: ${trace.moduleId} -->`);
  lines.push(`<!-- trace-version: ${trace.version} -->`);
  lines.push(`<!-- last-generated: ${trace.lastGenerated} -->`);
  lines.push(`<!-- generated-by: ${trace.generatedBy} -->`);
  lines.push('');
  lines.push(`# Low-Level Trace: ${moduleConfig.name}`);
  lines.push('');

  for (const file of trace.files) {
    lines.push(`## File: ${file.filePath}`);
    lines.push('');

    // Exports section (AC-3.2: pipe-delimited format, enhanced with line numbers and signatures)
    lines.push('### Exports');
    lines.push('');
    if (file.exports.length > 0) {
      lines.push('symbol | type | line | signature');
      lines.push('--- | --- | --- | ---');
      for (const exp of file.exports) {
        const lineNum = exp.lineNumber != null ? String(exp.lineNumber) : '';
        // Sanitize signature for markdown output (AC-1.14)
        const sig = exp.signature ? sanitizeMarkdown(exp.signature) : '';
        lines.push(`${sanitizeMarkdown(exp.symbol)} | ${exp.type} | ${lineNum} | ${sig}`);
      }
    } else {
      lines.push('_No exports_');
    }
    lines.push('');

    // Imports section (AC-3.2: pipe-delimited format)
    lines.push('### Imports');
    lines.push('');
    if (file.imports.length > 0) {
      lines.push('source | symbols');
      lines.push('--- | ---');
      for (const imp of file.imports) {
        const symbolsStr = imp.symbols.length > 0 ? imp.symbols.join(', ') : '(side-effect)';
        lines.push(`${imp.source} | ${symbolsStr}`);
      }
    } else {
      lines.push('_No imports_');
    }
    lines.push('');

    // Function Calls section (AC-3.2: pipe-delimited format)
    lines.push('### Function Calls');
    lines.push('');
    if (file.calls.length > 0) {
      lines.push('target | function | context');
      lines.push('--- | --- | ---');
      for (const call of file.calls) {
        lines.push(`${call.target} | ${call.function} | ${call.context || ''}`);
      }
    } else {
      lines.push('_No function calls traced (v1: manual population)_');
    }
    lines.push('');

    // Events section (AC-3.2: pipe-delimited format)
    lines.push('### Events');
    lines.push('');
    if (file.events.length > 0) {
      lines.push('type | event-name | channel');
      lines.push('--- | --- | ---');
      for (const evt of file.events) {
        lines.push(`${evt.type} | ${evt.eventName} | ${evt.channel}`);
      }
    } else {
      lines.push('_No events traced (v1: manual population)_');
    }
    lines.push('');
  }

  // Freeform notes section (not synced)
  lines.push('## Notes (not synced)');
  lines.push('');

  return lines.join('\n');
}

/**
 * Write low-level trace files (JSON + markdown) for a single module.
 *
 * @param {{ id: string, name: string, description?: string, fileGlobs: string[] }} moduleConfig
 * @param {{ version: number, modules: Array }} traceConfig
 * @param {string} projectRoot
 * @returns {{ moduleId: string, fileCount: number, version: number }}
 */
export function writeLowLevelTrace(moduleConfig, traceConfig, projectRoot) {
  const trace = generateLowLevelTrace(moduleConfig, traceConfig, projectRoot);

  // Ensure low-level directory exists (AC-5.3 partial: directory creation)
  const lowLevelDir = join(projectRoot, LOW_LEVEL_TRACE_DIR);
  mkdirSync(lowLevelDir, { recursive: true });

  // Write JSON (canonical)
  const jsonPath = join(lowLevelDir, `${moduleConfig.id}.json`);
  writeFileSync(jsonPath, JSON.stringify(trace, null, 2) + '\n');

  // Write markdown (generated view)
  const mdPath = join(lowLevelDir, `${moduleConfig.id}.md`);
  const markdown = generateLowLevelMarkdown(trace, moduleConfig);
  writeFileSync(mdPath, markdown);

  return {
    moduleId: moduleConfig.id,
    fileCount: trace.files.length,
    version: trace.version,
  };
}

/**
 * Generate low-level traces for all modules or a specific module.
 *
 * @param {string} [targetModuleId] - If provided, generate only this module
 * @param {string} [projectRoot] - Optional project root override
 * @returns {{ modulesProcessed: number, results: Array<{ moduleId: string, fileCount: number, version: number }> }}
 */
export function generateAllLowLevelTraces(targetModuleId, projectRoot) {
  const root = projectRoot || resolveProjectRoot();
  const config = loadTraceConfig(root);

  // Ensure traces directory structure exists
  const lowLevelDir = join(root, LOW_LEVEL_TRACE_DIR);
  mkdirSync(lowLevelDir, { recursive: true });

  const results = [];
  let modulesProcessed = 0;

  for (const mod of config.modules) {
    // If targeting a specific module, skip others
    if (targetModuleId && mod.id !== targetModuleId) {
      continue;
    }

    const result = writeLowLevelTrace(mod, config, root);
    results.push(result);
    modulesProcessed++;
  }

  if (targetModuleId && modulesProcessed === 0) {
    const availableIds = config.modules.map(m => m.id);
    const availableList = availableIds.length > 0
      ? `Available modules: ${availableIds.join(', ')}`
      : 'No modules defined in trace.config.json';
    throw new Error(
      `Module "${targetModuleId}" not found in trace.config.json. ${availableList}`,
    );
  }

  return { modulesProcessed, results };
}

// =============================================================================
// LowLevelTrace Schema Validation
// =============================================================================

/**
 * Validate a low-level trace object against the LowLevelTrace schema.
 *
 * AC-3.1: JSON validates against the LowLevelTrace schema including all
 * required fields (moduleId, version, lastGenerated, generatedBy, files
 * array with filePath/exports/imports/calls/events per entry).
 *
 * @param {object} trace - Low-level trace data to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateLowLevelTrace(trace) {
  const errors = [];

  // Top-level required fields
  if (typeof trace.moduleId !== 'string' || !trace.moduleId) {
    errors.push('moduleId must be a non-empty string');
  }
  if (typeof trace.version !== 'number' || !Number.isInteger(trace.version)) {
    errors.push('version must be an integer');
  }
  if (typeof trace.lastGenerated !== 'string' || !trace.lastGenerated) {
    errors.push('lastGenerated must be a non-empty string');
  } else {
    const d = new Date(trace.lastGenerated);
    if (Number.isNaN(d.getTime())) {
      errors.push('lastGenerated must be a valid ISO 8601 date-time');
    }
  }
  if (typeof trace.generatedBy !== 'string' || !trace.generatedBy) {
    errors.push('generatedBy must be a non-empty string');
  }
  if (!Array.isArray(trace.files)) {
    errors.push('files must be an array');
    return { valid: false, errors };
  }

  // Validate each file entry
  for (let i = 0; i < trace.files.length; i++) {
    const file = trace.files[i];
    const prefix = `files[${i}]`;

    if (typeof file.filePath !== 'string' || !file.filePath) {
      errors.push(`${prefix}.filePath must be a non-empty string`);
    }
    if (!Array.isArray(file.exports)) {
      errors.push(`${prefix}.exports must be an array`);
    } else {
      for (let j = 0; j < file.exports.length; j++) {
        const exp = file.exports[j];
        if (typeof exp.symbol !== 'string') {
          errors.push(`${prefix}.exports[${j}].symbol must be a string`);
        }
        if (typeof exp.type !== 'string') {
          errors.push(`${prefix}.exports[${j}].type must be a string`);
        } else {
          const validTypes = ['function', 'class', 'interface', 'type', 'const', 'enum', 'default'];
          if (!validTypes.includes(exp.type)) {
            errors.push(`${prefix}.exports[${j}].type must be one of: ${validTypes.join(', ')}`);
          }
        }
      }
    }
    if (!Array.isArray(file.imports)) {
      errors.push(`${prefix}.imports must be an array`);
    } else {
      for (let j = 0; j < file.imports.length; j++) {
        const imp = file.imports[j];
        if (typeof imp.source !== 'string') {
          errors.push(`${prefix}.imports[${j}].source must be a string`);
        }
        if (!Array.isArray(imp.symbols)) {
          errors.push(`${prefix}.imports[${j}].symbols must be an array`);
        }
      }
    }
    if (!Array.isArray(file.calls)) {
      errors.push(`${prefix}.calls must be an array`);
    }
    if (!Array.isArray(file.events)) {
      errors.push(`${prefix}.events must be an array`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// =============================================================================
// Cross-Module Dependency Aggregation (REQ-001, REQ-002, REQ-008, REQ-009)
// =============================================================================

/**
 * Aggregate cross-module dependencies from low-level trace data.
 *
 * Iterates each module's files' imports and resolves each import path
 * against all modules' fileGlobs using all-match semantics.
 *
 * - If exactly one module matches: records string moduleId as dependency
 * - If multiple modules match: skips, emits error, records in skippedFiles[]
 * - If no module matches: skips silently (external/untracked)
 * - Circular dependencies are represented bidirectionally
 * - Barrel re-exports are attributed to the re-exporting module
 * - Dynamic imports are excluded (only static imports are processed)
 *
 * Implements: REQ-001, REQ-002, REQ-008, REQ-009, REQ-010, REQ-011, REQ-020
 *
 * @param {Array<{ moduleId: string, files: Array<{ filePath: string, imports: Array<{ source: string, symbols: string[] }> }> }>} lowLevelTraces
 * @param {{ modules: Array<{ id: string, name: string, fileGlobs: string[] }> }} config
 * @returns {{ dependencyData: Object<string, { dependencies: string[], dependents: string[] }>, skippedFiles: Array<{ path: string, matchedModules: string[] }> }}
 */
export function aggregateDependencies(lowLevelTraces, config) {
  // Build a set of all module IDs for quick lookup
  const moduleIds = new Set(config.modules.map(m => m.id));

  // Maps: moduleId -> Set of dependent moduleIds
  const depsMap = new Map();   // module -> modules it depends on
  const revMap = new Map();    // module -> modules that depend on it
  const skippedFiles = [];
  const seenSkipped = new Set();

  for (const modId of moduleIds) {
    depsMap.set(modId, new Set());
    revMap.set(modId, new Set());
  }

  for (const trace of lowLevelTraces) {
    const sourceModuleId = trace.moduleId;
    if (!moduleIds.has(sourceModuleId)) continue;

    for (const file of trace.files) {
      for (const imp of file.imports) {
        // REQ-011: Skip dynamic imports. parseImports only captures static
        // imports and require() statements, so dynamic import() calls
        // are already excluded by design. No additional filtering needed.

        // Resolve import source path. For relative imports, resolve against
        // the importing file's directory. For bare specifiers (packages), skip.
        const importSource = imp.source;

        // Skip bare module specifiers (no ./ or ../ prefix, not an absolute path)
        if (!importSource.startsWith('.') && !importSource.startsWith('/')) {
          continue; // REQ-009: External package, skip silently
        }

        // Resolve relative import path against the importing file's directory
        const importingDir = file.filePath.includes('/')
          ? file.filePath.substring(0, file.filePath.lastIndexOf('/'))
          : '.';

        // Simple path resolution: join importing dir with import source
        let resolvedPath = resolveImportPath(importingDir, importSource);

        // Skip if resolution failed (e.g., excessive ../ escaping project root)
        if (resolvedPath == null) {
          continue;
        }

        // Try to find matching modules for the resolved path
        // We need to try with common extensions if the import doesn't have one
        const pathsToTry = [resolvedPath];
        if (!/\.\w+$/.test(resolvedPath)) {
          // No extension -- try common TS/JS extensions
          pathsToTry.push(
            resolvedPath + '.ts',
            resolvedPath + '.tsx',
            resolvedPath + '.js',
            resolvedPath + '.jsx',
            resolvedPath + '.mjs',
            resolvedPath + '.cjs',
            resolvedPath + '/index.ts',
            resolvedPath + '/index.tsx',
            resolvedPath + '/index.js',
            resolvedPath + '/index.mjs',
          );
        }

        let matchedModules = [];
        for (const pathCandidate of pathsToTry) {
          const matches = fileToModules(pathCandidate, config);
          if (matches.length > 0) {
            matchedModules = matches;
            break;
          }
        }

        if (matchedModules.length === 0) {
          // REQ-009: No module matches, skip silently
          continue;
        }

        if (matchedModules.length > 1) {
          // REQ-002: Ambiguous match -- config error
          const matchedIds = matchedModules.map(m => m.id).sort();
          const skippedKey = `${resolvedPath}:${matchedIds.join(',')}`;
          if (!seenSkipped.has(skippedKey)) {
            seenSkipped.add(skippedKey);
            process.stderr.write(
              `[trace-generate] WARNING: File "${resolvedPath}" matches multiple modules: ${matchedIds.join(', ')}. Skipping.\n`,
            );
            skippedFiles.push({ path: resolvedPath, matchedModules: matchedIds });
          }
          continue;
        }

        const targetModuleId = matchedModules[0].id;

        // Skip self-references (importing within the same module)
        if (targetModuleId === sourceModuleId) {
          continue;
        }

        // Record dependency: sourceModule depends on targetModule
        depsMap.get(sourceModuleId).add(targetModuleId);
        // Record reverse: targetModule is depended on by sourceModule
        revMap.get(targetModuleId).add(sourceModuleId);
      }
    }
  }

  // Build dependency data object keyed by moduleId
  const dependencyData = {};
  for (const modId of moduleIds) {
    dependencyData[modId] = {
      dependencies: [...depsMap.get(modId)].sort(),
      dependents: [...revMap.get(modId)].sort(),
    };
  }

  return { dependencyData, skippedFiles };
}

/**
 * Resolve a relative import path against an importing directory.
 *
 * Simple path resolution without filesystem access. Handles . and .. segments.
 *
 * @param {string} fromDir - Directory of the importing file (relative to project root)
 * @param {string} importPath - The import specifier (e.g., '../utils' or './helper')
 * @returns {string | null} Resolved path relative to project root, or null if resolution escapes root
 */
function resolveImportPath(fromDir, importPath) {
  const parts = fromDir === '.' ? [] : fromDir.split('/');
  const importParts = importPath.split('/');

  for (const segment of importParts) {
    if (segment === '.') {
      // Current directory, no change
      continue;
    } else if (segment === '..') {
      // Go up one directory; guard against escaping project root
      if (parts.length === 0) {
        continue;
      }
      parts.pop();
    } else {
      parts.push(segment);
    }
  }

  const resolved = parts.join('/');
  // If resolution produced an empty path, the import is invalid
  if (resolved === '') {
    return null;
  }

  return resolved;
}

// =============================================================================
// Full Trace Generation (AC-5.1, AC-5.3, AC-5.4)
// =============================================================================

/**
 * Generate all traces: high-level + low-level for all modules (or a target module).
 *
 * AC-5.1: Produces high-level.json, high-level.md, and per-module low-level files
 * AC-5.3: Creates .claude/traces/ and low-level/ directories if they do not exist
 * AC-5.4: Returns summary with modules processed, files generated, and duration
 *
 * @param {object} [options]
 * @param {string} [options.targetModuleId] - If provided, generate only this module's low-level trace + update high-level
 * @param {string} [options.projectRoot] - Project root override
 * @param {boolean} [options.lowLevelOnly] - Skip high-level trace generation
 * @returns {{ modulesProcessed: number, filesGenerated: number, durationMs: number, lowLevelResults: Array, highLevelVersion: number | null }}
 */
export function generateAllTraces(options = {}) {
  const startTime = Date.now();
  const root = options.projectRoot || resolveProjectRoot();
  const targetModuleId = options.targetModuleId || undefined;
  const lowLevelOnly = options.lowLevelOnly || false;

  // AC-5.3: Ensure directory structure exists
  const tracesDir = join(root, '.claude', 'traces');
  const lowLevelDir = join(tracesDir, 'low-level');
  mkdirSync(lowLevelDir, { recursive: true });

  let filesGenerated = 0;
  let highLevelVersion = null;

  // Step 1: Generate low-level traces for all modules (or target module)
  // Must happen before high-level trace so dependency aggregation has import data.
  const { modulesProcessed, results: lowLevelResults } = generateAllLowLevelTraces(targetModuleId, root);
  filesGenerated += lowLevelResults.length * 2; // .json + .md per module

  // Step 2: Generate high-level trace with dependency aggregation (unless --low-level-only)
  if (!lowLevelOnly) {
    const config = loadTraceConfig(root);

    // Read all low-level traces for dependency aggregation
    const lowLevelTraces = [];
    for (const mod of config.modules) {
      const tracePath = join(root, LOW_LEVEL_TRACE_DIR, `${mod.id}.json`);
      try {
        const traceData = JSON.parse(readFileSync(tracePath, 'utf-8'));
        lowLevelTraces.push(traceData);
      } catch {
        // Module trace may not exist yet (no matching files, etc.) -- skip
      }
    }

    // Aggregate cross-module dependencies from import data
    const { dependencyData, skippedFiles } = aggregateDependencies(lowLevelTraces, config);

    const highLevelResult = generateHighLevelTrace({
      projectRoot: root,
      config,
      dependencyData,
      skippedFiles,
    });
    highLevelVersion = highLevelResult.version;
    filesGenerated += 2; // high-level.json + high-level.md
  }

  const durationMs = Date.now() - startTime;

  return {
    modulesProcessed,
    filesGenerated,
    durationMs,
    lowLevelResults,
    highLevelVersion,
  };
}

// =============================================================================
// Bootstrap: Auto-Detection and Initial Config Generation (AC-13.1 through AC-13.4)
// =============================================================================

/**
 * Convert a directory name to a human-readable module name.
 *
 * Transforms kebab-case or snake_case directory names to Title Case.
 * Examples: "node-server" -> "Node Server", "agent_orchestrator" -> "Agent Orchestrator"
 *
 * @param {string} dirName - Directory name
 * @returns {string} Human-readable name
 */
export function dirNameToModuleName(dirName) {
  return dirName
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Convert a directory name to a module ID.
 *
 * Ensures the ID matches the trace config schema pattern: ^[a-z0-9-]+$
 * Examples: "node-server" -> "node-server", "Agent_Orchestrator" -> "agent-orchestrator"
 *
 * @param {string} dirName - Directory name
 * @param {string} [prefix] - Optional prefix (e.g., "apps" parent dir)
 * @returns {string} Module ID
 */
export function dirNameToModuleId(dirName, prefix) {
  const base = dirName.toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
  return prefix ? `${prefix}-${base}` : base;
}

/**
 * Scan a project directory to auto-detect module boundaries.
 *
 * AC-13.2: Auto-detected modules are based on project structure.
 * Scans for:
 *   - Subdirectories under apps/ (each is a module)
 *   - Subdirectories under packages/ (each is a module)
 *   - .claude/scripts/ (if it exists, as a single module)
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {Array<{ id: string, name: string, description: string, fileGlobs: string[] }>}
 */
export function autoDetectModules(projectRoot) {
  const modules = [];

  // Scan apps/ directory
  const appsDir = join(projectRoot, 'apps');
  if (existsSync(appsDir)) {
    try {
      const entries = readdirSync(appsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          modules.push({
            id: dirNameToModuleId(entry.name),
            name: dirNameToModuleName(entry.name),
            description: `Application: ${entry.name}`,
            fileGlobs: [`apps/${entry.name}/**`],
          });
        }
      }
    } catch {
      // Directory read failed -- skip
    }
  }

  // Scan packages/ directory
  const packagesDir = join(projectRoot, 'packages');
  if (existsSync(packagesDir)) {
    try {
      const entries = readdirSync(packagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          modules.push({
            id: dirNameToModuleId(entry.name, 'pkg'),
            name: `${dirNameToModuleName(entry.name)} Package`,
            description: `Package: ${entry.name}`,
            fileGlobs: [`packages/${entry.name}/**`],
          });
        }
      }
    } catch {
      // Directory read failed -- skip
    }
  }

  // Scan for .claude/scripts/ directory
  const claudeScriptsDir = join(projectRoot, '.claude', 'scripts');
  if (existsSync(claudeScriptsDir)) {
    modules.push({
      id: 'claude-scripts',
      name: 'Claude Scripts',
      description: 'Claude Code hook scripts, utilities, and automation tooling',
      fileGlobs: ['.claude/scripts/**'],
    });
  }

  // Scan for top-level src/ directory (non-monorepo projects)
  const srcDir = join(projectRoot, 'src');
  if (existsSync(srcDir) && modules.length === 0) {
    modules.push({
      id: 'src',
      name: 'Source',
      description: 'Project source code',
      fileGlobs: ['src/**'],
    });
  }

  return modules;
}

/**
 * Generate a starter trace.config.json from auto-detected modules.
 *
 * AC-13.1: Creates trace.config.json with auto-detected module definitions.
 * AC-13.4: Only runs when trace.config.json does not already exist.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {{ config: object, configPath: string }} The generated config and its file path
 */
export function bootstrapTraceConfig(projectRoot) {
  const tracesDir = join(projectRoot, '.claude', 'traces');
  const configPath = join(tracesDir, 'trace.config.json');

  // AC-13.4: Guard -- do not re-bootstrap if config already exists
  if (existsSync(configPath)) {
    throw new Error(
      'trace.config.json already exists. Bootstrap is only for first-time setup. ' +
      'To regenerate traces, run: node .claude/scripts/trace-generate.mjs',
    );
  }

  // AC-13.2: Auto-detect modules from project structure
  const detectedModules = autoDetectModules(projectRoot);

  const config = {
    version: 1,
    projectRoot: '.',
    modules: detectedModules,
  };

  // AC-13.1: Create directory structure and write config
  mkdirSync(tracesDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  return { config, configPath };
}

// =============================================================================
// CLI Entry Point
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const targetModule = args.find(a => !a.startsWith('--'));
  const lowLevelOnly = args.includes('--low-level-only');
  const bootstrapFlag = args.includes('--bootstrap');

  try {
    const root = resolveProjectRoot();

    // AC-13.1, AC-13.4: Bootstrap mode -- auto-detect modules and create config
    if (bootstrapFlag) {
      const configPath = join(root, '.claude', 'traces', 'trace.config.json');

      if (existsSync(configPath)) {
        // AC-13.4: Config already exists, skip bootstrap
        console.log('trace.config.json already exists. Skipping bootstrap.');
        console.log('Running full trace generation with existing config...');
        console.log('');
      } else {
        const { config } = bootstrapTraceConfig(root);

        // AC-13.3: Output message prompting user to review
        console.log('Bootstrap complete. Auto-detected modules:');
        console.log('');
        for (const mod of config.modules) {
          console.log(`  ${mod.id}: ${mod.name}`);
          console.log(`    Globs: ${mod.fileGlobs.join(', ')}`);
        }
        console.log('');
        console.log('Review and refine the module boundaries in:');
        console.log(`  .claude/traces/trace.config.json`);
        console.log('');
        console.log('Running initial trace generation...');
        console.log('');
      }
    }

    const result = generateAllTraces({
      targetModuleId: targetModule,
      lowLevelOnly,
    });

    // AC-5.4: Output summary reporting modules processed and files generated
    const modeLabel = targetModule
      ? `Trace generation complete (module: ${targetModule}).`
      : 'Trace generation complete.';
    console.log(modeLabel);
    console.log(`  Modules processed: ${result.modulesProcessed}`);
    console.log(`  Files generated: ${result.filesGenerated}`);
    console.log(`  Duration: ${result.durationMs}ms`);
    if (result.highLevelVersion !== null) {
      console.log(`  High-level trace: version ${result.highLevelVersion}`);
    }
    for (const r of result.lowLevelResults) {
      console.log(`  ${r.moduleId}: ${r.fileCount} files, version ${r.version}`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`Trace generation failed: ${err.message}`);
    process.exit(1);
  }
}

// Run main only if executed directly (not imported as a module by tests)
// Check: argv[1] must end exactly with 'trace-generate.mjs' (not 'trace-generate.test.mjs')
const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('trace-generate.mjs') &&
  !process.argv[1].endsWith('.test.mjs');

if (isMainModule) {
  main();
}
