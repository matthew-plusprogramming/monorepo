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
 *   node .claude/scripts/trace-generate.mjs --skip-architecture  # Skip architecture.yaml generation from trace config
 *
 * Implements: REQ-AT-004, REQ-AT-005, REQ-AT-006, REQ-AT-008, REQ-AT-009, REQ-AT-011
 * Spec: as-004-low-level-trace, as-005-trace-generate-command, as-013-trace-bootstrap
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import {
  loadTraceConfig,
  findFilesMatchingGlobs,
  fileToModules,
  resolveProjectRoot,
  formatTimestamp,
  sanitizeMarkdown,
  matchesGlob,
  LOW_LEVEL_TRACE_DIR,
  loadStalenessMetadata,
  writeStalenessMetadata,
  createEmptyStalenessData,
  computeFileHash,
  computeExportSignatureHash,
  isFileStale,
  propagateCrossModuleStaleness,
  atomicWriteFile,
  checkTraceFileSize,
  resetFileCache,
  getCachedGitFiles,
} from './lib/trace-utils.mjs';

import {
  generateHighLevelTrace,
} from './lib/high-level-trace.mjs';

import {
  analyzeSourceWithCompiler,
} from './lib/ts-analyzer.mjs';

import YAML from 'yaml';

// =============================================================================
// Constants
// =============================================================================

const GENERATED_BY = 'trace-generate';

/** Maximum cache size in bytes before workers fall back to direct file reads (AC-7) */
const WORKER_CACHE_THRESHOLD_BYTES = 256 * 1024 * 1024;

/** Default worker concurrency cap (AC-7) */
const DEFAULT_MAX_WORKERS = 4;

/** AC-5.2: Sidecar file size warning threshold in bytes (default 10MB) */
const SIDECAR_SIZE_WARNING_BYTES = 10 * 1024 * 1024;

/** AC-3.6: Stale temp file age threshold in milliseconds (1 hour) */
const STALE_TEMP_FILE_AGE_MS = 60 * 60 * 1000;

// =============================================================================
// Stale Temp File Cleanup (AC-3.6)
// =============================================================================

/**
 * Clean up stale .tmp.* files in the given directory.
 *
 * AC-3.6: On startup, scans for .tmp.* files older than STALE_TEMP_FILE_AGE_MS
 * (1 hour) and deletes them. These can accumulate from crashed trace generation
 * processes.
 *
 * @param {string} dir - Directory to scan for stale temp files
 */
function cleanupStaleTempFiles(dir) {
  try {
    const entries = readdirSync(dir);
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.includes('.tmp.')) continue;

      const filePath = join(dir, entry);
      try {
        const stat = statSync(filePath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs > STALE_TEMP_FILE_AGE_MS) {
          unlinkSync(filePath);
          process.stderr.write(`[trace] Cleaned up stale temp file: ${entry} (age: ${Math.round(ageMs / 60000)}min)\n`);
        }
      } catch {
        // Stat or unlink failed -- skip this file
      }
    }
  } catch {
    // Directory read failed -- skip cleanup
  }
}

// =============================================================================
// File Content Cache (AC-4)
// =============================================================================

/**
 * Module-scoped file content cache.
 * Populated during buildExportIndex and reused by analyzeFile and computeFileHash.
 * @type {Map<string, string>}
 */
const fileContentCache = new Map();

/**
 * Get file content, using cache if available.
 *
 * AC-4: Eliminates double file reads by caching content on first access.
 * Both buildExportIndex (regex parsing) and analyzeFile (TS compiler) read
 * the same files; this cache ensures each file is read from disk at most once.
 *
 * @param {string} absPath - Absolute path to the file
 * @returns {string} File content
 */
function getCachedContent(absPath) {
  let cached = fileContentCache.get(absPath);
  if (cached !== undefined) {
    return cached;
  }
  cached = readFileSync(absPath, 'utf-8');
  fileContentCache.set(absPath, cached);
  return cached;
}

/**
 * Get the approximate total size of the file content cache in bytes.
 *
 * Used to determine whether to serialize the cache for workers (AC-7).
 *
 * @returns {number} Approximate byte size
 */
function getContentCacheSize() {
  let total = 0;
  for (const value of fileContentCache.values()) {
    total += value.length * 2; // Approximate: JS strings are UTF-16
  }
  return total;
}

/**
 * Prime the file content cache with pre-computed entries.
 *
 * Used by worker threads to avoid redundant file reads. The main thread
 * serializes cached file contents and workers reconstruct the cache.
 *
 * @param {Array<[string, string]>} entries - Array of [absPath, content] pairs
 */
export function primeContentCache(entries) {
  for (const [key, value] of entries) {
    fileContentCache.set(key, value);
  }
}

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
// Call Graph Analysis (REQ-002)
// =============================================================================

/**
 * Parse function call patterns from source code using regex-based detection.
 *
 * Identifies `identifier(` patterns in source code and resolves callees against
 * the importMap (imported symbols) and knownExports (all known exports from
 * traced modules). Unresolved callees get calleeFile: null, calleeLine: null.
 *
 * Implements: REQ-002 (contract-calls-events-schema)
 *
 * @param {string} source - File source code
 * @param {Array<{ source: string, symbols: string[] }>} importMap - Parsed imports from this file
 * @param {Map<string, { file: string, line: number }>} knownExports - Cross-module export index: symbol name -> { file, line }
 * @param {string} filePath - Relative path of the file being analyzed (for callerFile)
 * @returns {Array<{ callerFile: string, callerLine: number, calleeName: string, calleeFile: string|null, calleeLine: number|null }>}
 */
export function parseCallGraph(source, importMap, knownExports, filePath) {
  const calls = [];
  const seen = new Set(); // Deduplicate: "callerLine:calleeName"

  // Build a map of imported symbol -> source module path for resolution
  const importedSymbolToSource = new Map();
  for (const imp of importMap) {
    for (const sym of imp.symbols) {
      // Handle "* as X" namespace imports
      if (sym.startsWith('* as ')) continue;
      importedSymbolToSource.set(sym, imp.source);
    }
  }

  // Remove block comments while preserving line numbers
  const cleaned = removeBlockCommentsPreserveLines(source);
  const lines = cleaned.split('\n');

  // Regex to detect function calls: identifier followed by (
  // Excludes: keywords, string content, import/export/from statements
  const CALL_PATTERN = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
  const JS_KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    'return', 'throw', 'try', 'catch', 'finally', 'new', 'typeof', 'instanceof',
    'void', 'delete', 'in', 'of', 'class', 'function', 'async', 'await',
    'import', 'export', 'from', 'const', 'let', 'var', 'super', 'this',
    'yield', 'with', 'debugger', 'default', 'extends', 'static',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();
    const lineNumber = i + 1;

    // Skip single-line comments
    if (trimmedLine.startsWith('//')) continue;

    // Skip import/export declaration lines (already captured by parseImports/parseExports)
    if (/^\s*(import|export)\s+/.test(line)) continue;

    // Find all function call patterns on this line
    let match;
    CALL_PATTERN.lastIndex = 0;
    while ((match = CALL_PATTERN.exec(line)) !== null) {
      const calleeName = match[1];

      // Skip JavaScript keywords
      if (JS_KEYWORDS.has(calleeName)) continue;

      // Skip common non-function patterns (e.g., method chain receivers)
      // But keep the actual function call
      const dedupKey = `${lineNumber}:${calleeName}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      // Resolve callee: check imported symbols, then known exports
      let calleeFile = null;
      let calleeLine = null;

      // Check if calleeName is an imported symbol
      if (importedSymbolToSource.has(calleeName)) {
        // It's imported -- try to resolve via knownExports
        const exportInfo = knownExports.get(calleeName);
        if (exportInfo) {
          calleeFile = exportInfo.file;
          calleeLine = exportInfo.line;
        }
      } else {
        // Not imported -- still check knownExports (same-module calls)
        const exportInfo = knownExports.get(calleeName);
        if (exportInfo) {
          calleeFile = exportInfo.file;
          calleeLine = exportInfo.line;
        }
      }

      calls.push({
        callerFile: filePath,
        callerLine: lineNumber,
        calleeName,
        calleeFile,
        calleeLine,
      });
    }
  }

  return calls;
}

// =============================================================================
// Event Pattern Detection (REQ-003)
// =============================================================================

/**
 * Parse event emit/subscribe patterns from source code.
 *
 * Detects patterns like:
 *   - .emit('eventName', ...)
 *   - .on('eventName', ...)
 *   - .addEventListener('eventName', ...)
 *   - .subscribe('eventName', ...)
 *   - .once('eventName', ...)
 *   - .addListener('eventName', ...)
 *   - .removeListener('eventName', ...)
 *   - .off('eventName', ...)
 *
 * Implements: REQ-003 (contract-calls-events-schema)
 *
 * @param {string} source - File source code
 * @param {string} filePath - Relative path of the file being analyzed
 * @returns {Array<{ file: string, line: number, eventName: string, type: "emit"|"subscribe" }>}
 */
export function parseEventPatterns(source, filePath) {
  const events = [];

  // Remove block comments while preserving line numbers
  const cleaned = removeBlockCommentsPreserveLines(source);
  const lines = cleaned.split('\n');

  // Emit patterns: .emit(, .dispatch(, .trigger(
  const EMIT_METHODS = new Set(['emit', 'dispatch', 'trigger']);
  // Subscribe patterns: .on(, .addEventListener(, .subscribe(, .once(, .addListener(
  const SUBSCRIBE_METHODS = new Set(['on', 'addEventListener', 'subscribe', 'once', 'addListener']);

  // Pattern: .methodName('eventName' or .methodName("eventName"
  const EVENT_PATTERN = /\.(\w+)\(\s*['"`]([^'"`]+)['"`]/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();
    const lineNumber = i + 1;

    // Skip single-line comments
    if (trimmedLine.startsWith('//')) continue;

    let match;
    EVENT_PATTERN.lastIndex = 0;
    while ((match = EVENT_PATTERN.exec(line)) !== null) {
      const methodName = match[1];
      const eventName = match[2];

      let type = null;
      if (EMIT_METHODS.has(methodName)) {
        type = 'emit';
      } else if (SUBSCRIBE_METHODS.has(methodName)) {
        type = 'subscribe';
      }

      if (type) {
        events.push({
          file: filePath,
          line: lineNumber,
          eventName,
          type,
        });
      }
    }
  }

  return events;
}

// =============================================================================
// Low-Level Trace Generation
// =============================================================================

/** Default file extensions for analysis (REQ-022) */
const DEFAULT_FILE_EXTENSIONS = ['.mjs', '.js'];

/** All supported file extensions (superset for extension matching) */
const ALL_ANALYZABLE_EXTENSIONS_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Analyze a single file for imports, exports, calls, and events.
 *
 * M4 (REQ-020, REQ-021, REQ-022): Delegates to TypeScript compiler API-based
 * analysis by default. The optional third `config` parameter controls behavior:
 *   - config.parser: 'compiler' (default) | 'regex' (legacy fallback)
 *   - config.fileExtensions: string[] (default: ['.mjs', '.js'])
 *
 * When called as analyzeFile(filePath, projectRoot) or
 * analyzeFile(filePath, projectRoot, knownExports), behavior is identical
 * to M1-M3 except using the TS compiler for better accuracy.
 *
 * The third parameter is polymorphic for backward compatibility:
 *   - If it's a Map, it's treated as knownExports (M1-M3 calling convention)
 *   - If it's a plain object, it's treated as config (M4 calling convention)
 *
 * @param {string} filePath - Relative path from project root
 * @param {string} projectRoot - Absolute project root path
 * @param {Map<string, { file: string, line: number }> | object} [configOrExports] - Config object or knownExports Map
 * @returns {{ filePath: string, exports: Array, imports: Array, calls: Array, events: Array }}
 */
export function analyzeFile(filePath, projectRoot, configOrExports) {
  const absPath = join(projectRoot, filePath);

  // Default entry with empty arrays
  const entry = {
    filePath,
    exports: [],
    imports: [],
    calls: [],
    events: [],
  };

  // Resolve the polymorphic third parameter
  let knownExports = new Map();
  let config = {};

  if (configOrExports instanceof Map) {
    // M1-M3 calling convention: analyzeFile(filePath, projectRoot, knownExports)
    knownExports = configOrExports;
  } else if (configOrExports && typeof configOrExports === 'object') {
    // M4 calling convention: analyzeFile(filePath, projectRoot, config)
    config = configOrExports;
    if (config.knownExports instanceof Map) {
      knownExports = config.knownExports;
    }
  }

  // REQ-022: Configurable file extensions
  const fileExtensions = config.fileExtensions || DEFAULT_FILE_EXTENSIONS;

  // Check if this file extension is analyzable
  if (!ALL_ANALYZABLE_EXTENSIONS_PATTERN.test(filePath)) {
    return entry;
  }

  // REQ-022: Additional check against configured extensions
  // Only skip if extensions are explicitly configured and this extension is not in the list
  if (config.fileExtensions) {
    const fileExt = filePath.match(/\.[^.]+$/)?.[0];
    if (fileExt && !fileExtensions.includes(fileExt)) {
      return entry;
    }
  }

  // Determine analysis strategy (REQ-020, REQ-021)
  const useRegex = config.parser === 'regex';

  try {
    // AC-4: Use cached file content to avoid redundant disk reads
    const source = getCachedContent(absPath);

    if (useRegex) {
      // Legacy regex-based analysis (fallback)
      entry.exports = parseExports(source);
      entry.imports = parseImports(source);
      entry.calls = parseCallGraph(source, entry.imports, knownExports, filePath);
      entry.events = parseEventPatterns(source, filePath);
    } else {
      // M4: TypeScript compiler API-based analysis (default)
      const result = analyzeSourceWithCompiler(source, filePath, knownExports);
      entry.exports = result.exports;
      entry.imports = result.imports;
      entry.calls = result.calls;
      entry.events = result.events;
    }
  } catch (err) {
    // Surface analysis failures without breaking the pipeline
    // This can happen for binary files, permission issues, or TS compiler crashes
    process.stderr.write(`Warning: trace analysis failed for ${filePath}: ${err.message}\n`);
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
export function generateLowLevelTrace(moduleConfig, traceConfig, projectRoot, knownExports) {
  // Find all files matching the module's globs
  let matchingFiles = findFilesMatchingGlobs(moduleConfig.fileGlobs, projectRoot);

  // AC-2.1: Filter out files matching globalExcludes (exclusion takes precedence over fileGlobs)
  const globalExcludes = traceConfig.globalExcludes || [];
  if (globalExcludes.length > 0) {
    const preFilterCount = matchingFiles.length;
    matchingFiles = matchingFiles.filter(filePath => {
      for (const pattern of globalExcludes) {
        if (matchesGlob(filePath, pattern)) {
          return false; // Excluded
        }
      }
      return true;
    });

    // AC-1.6: Warn if any pattern matches >90% of a module's files
    if (preFilterCount > 0) {
      const excludedCount = preFilterCount - matchingFiles.length;
      const excludedPct = excludedCount / preFilterCount;
      if (excludedPct > 0.9) {
        process.stderr.write(
          `[trace] WARNING: globalExcludes patterns matched ${excludedCount}/${preFilterCount} files ` +
          `(${(excludedPct * 100).toFixed(0)}%) in module "${moduleConfig.id}". ` +
          `Patterns: ${globalExcludes.join(', ')}\n`
        );
      }
    }

    // AC-2.3: Warn when all files in a module are excluded
    if (matchingFiles.length === 0 && preFilterCount > 0) {
      process.stderr.write(
        `[trace] WARNING: All ${preFilterCount} files in module "${moduleConfig.id}" ` +
        `were excluded by globalExcludes. Module will have an empty files array.\n`
      );
    }
  }

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
  // Pass knownExports for cross-module call resolution (M1: REQ-002)
  const exportIndex = knownExports || new Map();
  const files = matchingFiles.map(filePath => analyzeFile(filePath, projectRoot, exportIndex));

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
 * Build a cross-module export index from all traced modules.
 *
 * Collects exports from all modules' files and builds a Map of
 * symbol name -> { file, line } for cross-module call resolution.
 *
 * @param {{ modules: Array<{ id: string, fileGlobs: string[] }> }} config - Trace config
 * @param {string} projectRoot - Absolute project root
 * @returns {Map<string, { file: string, line: number }>}
 */
export function buildExportIndex(config, projectRoot) {
  const exportIndex = new Map();
  const globalExcludes = config.globalExcludes || [];

  for (const mod of config.modules) {
    const matchingFiles = findFilesMatchingGlobs(mod.fileGlobs, projectRoot);
    for (const filePath of matchingFiles) {
      // AC-2.1: Skip files matching globalExcludes
      if (globalExcludes.length > 0) {
        let excluded = false;
        for (const pattern of globalExcludes) {
          if (matchesGlob(filePath, pattern)) {
            excluded = true;
            break;
          }
        }
        if (excluded) continue;
      }

      // Only analyze TS/JS files
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) continue;

      try {
        const absPath = join(projectRoot, filePath);
        // AC-4: Use cached content to avoid redundant disk reads
        const source = getCachedContent(absPath);
        const fileExports = parseExports(source);

        for (const exp of fileExports) {
          // First export wins (for determinism)
          if (!exportIndex.has(exp.symbol)) {
            exportIndex.set(exp.symbol, {
              file: filePath,
              line: exp.lineNumber || 0,
            });
          }
        }
      } catch {
        // File read failure -- skip
      }
    }
  }

  return exportIndex;
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

    // Function Calls section (M1: spec-defined column headers per contract-calls-events-schema)
    lines.push('### Function Calls');
    lines.push('');
    if (file.calls.length > 0) {
      lines.push('callerFile | callerLine | calleeName | calleeFile | calleeLine');
      lines.push('--- | --- | --- | --- | ---');
      for (const call of file.calls) {
        // Use '(none)' placeholder for null values to satisfy parsePipeDelimitedLine's empty field check
        const calleeFile = call.calleeFile || '(none)';
        const calleeLine = call.calleeLine != null ? String(call.calleeLine) : '(none)';
        lines.push(`${call.callerFile} | ${call.callerLine} | ${call.calleeName} | ${calleeFile} | ${calleeLine}`);
      }
    } else {
      lines.push('_No function calls traced_');
    }
    lines.push('');

    // Events section (M1: spec-defined column headers per contract-calls-events-schema)
    lines.push('### Events');
    lines.push('');
    if (file.events.length > 0) {
      lines.push('file | line | eventName | type');
      lines.push('--- | --- | --- | ---');
      for (const evt of file.events) {
        lines.push(`${evt.file} | ${evt.line} | ${evt.eventName} | ${evt.type}`);
      }
    } else {
      lines.push('_No events traced_');
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
 * Uses atomic write-rename pattern (REQ-012): writes to .tmp first,
 * then renames atomically. Checks trace file size (REQ-013) after write.
 *
 * @param {{ id: string, name: string, description?: string, fileGlobs: string[] }} moduleConfig
 * @param {{ version: number, modules: Array }} traceConfig
 * @param {string} projectRoot
 * @returns {{ moduleId: string, fileCount: number, version: number }}
 */
export function writeLowLevelTrace(moduleConfig, traceConfig, projectRoot, knownExports) {
  const trace = generateLowLevelTrace(moduleConfig, traceConfig, projectRoot, knownExports);

  // Ensure low-level directory exists (AC-5.3 partial: directory creation)
  const lowLevelDir = join(projectRoot, LOW_LEVEL_TRACE_DIR);
  mkdirSync(lowLevelDir, { recursive: true });

  // AC-3.1, AC-3.2: Separate calls data into sidecar file
  const sidecarFileName = `${moduleConfig.id}.calls.json`;
  const sidecarPath = join(lowLevelDir, sidecarFileName);
  const sidecarData = {};

  for (const file of trace.files) {
    // Build per-file keyed sidecar object
    if (file.calls && file.calls.length > 0) {
      sidecarData[file.filePath] = file.calls;
    } else {
      sidecarData[file.filePath] = [];
    }
  }

  // AC-3.4, AC-3.5: Atomic write-then-rename with PID-based temp filename
  const sidecarTmpPath = `${sidecarPath}.tmp.${process.pid}`;
  try {
    writeFileSync(sidecarTmpPath, JSON.stringify(sidecarData, null, 2) + '\n');
    renameSync(sidecarTmpPath, sidecarPath);
  } catch (err) {
    // AC-5.1: Log error with OS code, clean up temp (best-effort), continue
    process.stderr.write(
      `[trace] ERROR: Failed to write sidecar ${sidecarFileName}: ${err.message}` +
      (err.code ? ` (${err.code})` : '') + '\n'
    );
    try { unlinkSync(sidecarTmpPath); } catch { /* best-effort cleanup */ }
  }

  // AC-5.2: Size warning for large sidecar files
  try {
    const sidecarStat = statSync(sidecarPath);
    if (sidecarStat.size > SIDECAR_SIZE_WARNING_BYTES) {
      process.stderr.write(
        `[trace] WARNING: Sidecar file ${sidecarFileName} exceeds ${SIDECAR_SIZE_WARNING_BYTES / (1024 * 1024)}MB ` +
        `(actual: ${(sidecarStat.size / (1024 * 1024)).toFixed(1)}MB)\n`
      );
    }
  } catch { /* sidecar stat failed -- skip */ }

  // AC-3.2: Remove inline calls from file entries, add callsFile reference
  for (const file of trace.files) {
    delete file.calls;
  }
  trace.callsFile = sidecarFileName;

  // Write markdown using the full trace data (before calls removal -- use sidecar data for markdown)
  // Reconstruct file.calls temporarily for markdown generation
  for (const file of trace.files) {
    file.calls = sidecarData[file.filePath] || [];
  }
  const mdPath = join(lowLevelDir, `${moduleConfig.id}.md`);
  const markdown = generateLowLevelMarkdown(trace, moduleConfig);
  atomicWriteFile(mdPath, markdown);

  // Remove calls again for the JSON write
  for (const file of trace.files) {
    delete file.calls;
  }

  // REQ-012: Write JSON using atomic write-rename (trace file first per write ordering guarantee)
  const jsonPath = join(lowLevelDir, `${moduleConfig.id}.json`);
  atomicWriteFile(jsonPath, JSON.stringify(trace, null, 2) + '\n');

  // REQ-013: Check trace file size and emit warnings
  checkTraceFileSize(jsonPath, moduleConfig.id);

  return {
    moduleId: moduleConfig.id,
    fileCount: trace.files.length,
    version: trace.version,
  };
}

/**
 * Generate low-level traces for all modules or a specific module.
 *
 * AC-7: Supports parallel module analysis via worker_threads when
 * parallelWorkers > 0. Falls back to sequential when parallelWorkers === 0
 * or when targeting a specific module.
 *
 * @param {string} [targetModuleId] - If provided, generate only this module
 * @param {string} [projectRoot] - Optional project root override
 * @param {number} [parallelWorkers=0] - Number of worker threads (0 = sequential)
 * @returns {Promise<{ modulesProcessed: number, results: Array<{ moduleId: string, fileCount: number, version: number }> }>}
 */
export async function generateAllLowLevelTraces(targetModuleId, projectRoot, parallelWorkers = 0) {
  const root = projectRoot || resolveProjectRoot();
  const config = loadTraceConfig(root);

  // Ensure traces directory structure exists
  const lowLevelDir = join(root, LOW_LEVEL_TRACE_DIR);
  mkdirSync(lowLevelDir, { recursive: true });

  // AC-3.6: Clean up stale .tmp.* files older than 1 hour before generation begins
  cleanupStaleTempFiles(lowLevelDir);

  // M1: Build cross-module export index for call graph resolution (REQ-002)
  const knownExports = buildExportIndex(config, root);

  // Determine modules to process
  const modulesToProcess = targetModuleId
    ? config.modules.filter(m => m.id === targetModuleId)
    : config.modules;

  if (targetModuleId && modulesToProcess.length === 0) {
    const availableIds = config.modules.map(m => m.id);
    const availableList = availableIds.length > 0
      ? `Available modules: ${availableIds.join(', ')}`
      : 'No modules defined in trace.config.json';
    throw new Error(
      `Module "${targetModuleId}" not found in trace.config.json. ${availableList}`,
    );
  }

  // AC-7: Use parallel workers when available and processing multiple modules
  if (parallelWorkers > 0 && modulesToProcess.length > 1 && !targetModuleId) {
    const results = await processModulesInParallel(
      modulesToProcess, config, root, knownExports, parallelWorkers,
    );
    return { modulesProcessed: results.length, results };
  }

  // Sequential fallback (--parallel 0, single module, or targeting specific module)
  const results = [];
  for (const mod of modulesToProcess) {
    const result = writeLowLevelTrace(mod, config, root, knownExports);
    results.push(result);
  }

  return { modulesProcessed: results.length, results };
}

/**
 * Process modules in parallel using worker_threads.
 *
 * AC-7: Dispatches module analysis to worker threads with configurable concurrency.
 * Workers receive module config and known exports via workerData (structured clone).
 * The content cache is serialized only if below the 256MB threshold.
 *
 * @param {Array} modules - Modules to process
 * @param {object} config - Trace config
 * @param {string} root - Project root
 * @param {Map} knownExports - Cross-module export index
 * @param {number} concurrency - Number of concurrent workers
 * @returns {Promise<Array<{ moduleId: string, fileCount: number, version: number }>>}
 */
async function processModulesInParallel(modules, config, root, knownExports, concurrency) {
  const workerPath = new URL('./lib/trace-worker.mjs', import.meta.url);
  const exportEntries = [...knownExports.entries()];

  // AC-7: Check cache size against threshold for worker serialization
  const cacheSize = getContentCacheSize();
  const sendCache = cacheSize < WORKER_CACHE_THRESHOLD_BYTES;
  const fileContentEntries = sendCache ? [...fileContentCache.entries()] : null;

  const results = [];
  const queue = [...modules];
  const active = new Set();

  return new Promise((resolveAll) => {
    function startNext() {
      while (active.size < concurrency && queue.length > 0) {
        const mod = queue.shift();
        const worker = new Worker(workerPath, {
          workerData: {
            moduleConfig: mod,
            traceConfig: config,
            projectRoot: root,
            knownExports: exportEntries,
            cachedGitFiles: getCachedGitFiles(),
            fileContentEntries,
          },
        });

        active.add(worker);

        worker.on('message', (msg) => {
          active.delete(worker);
          if (msg.success) {
            results.push(msg.result);
          } else {
            process.stderr.write(`Warning: Worker failed for module ${mod.id}: ${msg.error}\n`);
            // Fall back to sequential for this module
            try {
              const result = writeLowLevelTrace(mod, config, root, knownExports);
              results.push(result);
            } catch (err) {
              process.stderr.write(`Warning: Sequential fallback also failed for ${mod.id}: ${err.message}\n`);
            }
          }
          startNext();
          if (active.size === 0 && queue.length === 0) {
            resolveAll(results);
          }
        });

        worker.on('error', (err) => {
          active.delete(worker);
          process.stderr.write(`Warning: Worker error for module ${mod.id}: ${err.message}\n`);
          // Fall back to sequential for this module
          try {
            const result = writeLowLevelTrace(mod, config, root, knownExports);
            results.push(result);
          } catch (fallbackErr) {
            process.stderr.write(`Warning: Sequential fallback also failed for ${mod.id}: ${fallbackErr.message}\n`);
          }
          startNext();
          if (active.size === 0 && queue.length === 0) {
            resolveAll(results);
          }
        });

        worker.on('exit', (code) => {
          // Guard: only handle if not already handled by 'message' or 'error'
          if (!active.has(worker)) return;
          active.delete(worker);
          if (code !== 0) {
            process.stderr.write(`Warning: Worker exited with code ${code} for module ${mod.id}\n`);
            // Fall back to sequential for this module
            try {
              const result = writeLowLevelTrace(mod, config, root, knownExports);
              results.push(result);
            } catch (fallbackErr) {
              process.stderr.write(`Warning: Sequential fallback also failed for ${mod.id}: ${fallbackErr.message}\n`);
            }
          }
          startNext();
          if (active.size === 0 && queue.length === 0) {
            resolveAll(results);
          }
        });
      }
    }

    startNext();

    // Handle edge case: empty modules list
    if (queue.length === 0 && active.size === 0) {
      resolveAll(results);
    }
  });
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

  // AC-3.7: When callsFile is present, file.calls is allowed to be absent/undefined
  const hasCallsFile = typeof trace.callsFile === 'string' || trace.callsFile === null;

  // Validate callsFile field if present (AC-3.2: string | null)
  if (trace.callsFile !== undefined) {
    if (trace.callsFile !== null && typeof trace.callsFile !== 'string') {
      errors.push('callsFile must be a string or null');
    }
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
    // AC-3.7: file.calls is accepted as either an array or absent/undefined when callsFile is present
    if (file.calls !== undefined) {
      if (!Array.isArray(file.calls)) {
        errors.push(`${prefix}.calls must be an array`);
      } else {
        // M1 (Task 1.5d): Validate each calls[] entry against CallEntry schema
        for (let j = 0; j < file.calls.length; j++) {
          const call = file.calls[j];
          const callPrefix = `${prefix}.calls[${j}]`;
          if (typeof call.callerFile !== 'string') {
            errors.push(`${callPrefix}.callerFile must be a string`);
          }
          if (typeof call.callerLine !== 'number' || !Number.isInteger(call.callerLine)) {
            errors.push(`${callPrefix}.callerLine must be an integer`);
          }
          if (typeof call.calleeName !== 'string') {
            errors.push(`${callPrefix}.calleeName must be a string`);
          }
          if (call.calleeFile !== null && typeof call.calleeFile !== 'string') {
            errors.push(`${callPrefix}.calleeFile must be a string or null`);
          }
          if (call.calleeLine !== null && (typeof call.calleeLine !== 'number' || !Number.isInteger(call.calleeLine))) {
            errors.push(`${callPrefix}.calleeLine must be an integer or null`);
          }
        }
      }
    } else if (!hasCallsFile) {
      // file.calls is absent and no callsFile -- this is an error in legacy format
      errors.push(`${prefix}.calls must be an array`);
    }
    if (!Array.isArray(file.events)) {
      errors.push(`${prefix}.events must be an array`);
    } else {
      // M1 (Task 1.5d): Validate each events[] entry against EventEntry schema
      for (let j = 0; j < file.events.length; j++) {
        const evt = file.events[j];
        const evtPrefix = `${prefix}.events[${j}]`;
        if (typeof evt.file !== 'string') {
          errors.push(`${evtPrefix}.file must be a string`);
        }
        if (typeof evt.line !== 'number' || !Number.isInteger(evt.line)) {
          errors.push(`${evtPrefix}.line must be an integer`);
        }
        if (typeof evt.eventName !== 'string') {
          errors.push(`${evtPrefix}.eventName must be a string`);
        }
        if (evt.type !== 'emit' && evt.type !== 'subscribe') {
          errors.push(`${evtPrefix}.type must be "emit" or "subscribe"`);
        }
      }
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
      // Go up one directory; reject paths that attempt to escape project root
      if (parts.length === 0) {
        return null;
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
// File-to-Module Map (AC-2)
// =============================================================================

/** Common file extensions to try when resolving extensionless import paths */
const IMPORT_EXTENSIONS = ['' /* try exact path first (may already have extension) */, '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

/**
 * Build a map from file path to module ID for O(1) external ref resolution.
 *
 * AC-2: Replaces the O(F x I x M) nested loop pattern with a pre-computed map.
 * Iterates all modules and their matched files once to build the map.
 *
 * @param {{ modules: Array<{ id: string, fileGlobs: string[] }> }} config - Trace config
 * @param {string} root - Project root directory
 * @returns {Map<string, string>} Map from relative file path to module ID
 */
function buildFileToModuleMap(config, root) {
  const map = new Map();
  for (const mod of config.modules) {
    const files = findFilesMatchingGlobs(mod.fileGlobs, root);
    for (const filePath of files) {
      // First module wins (consistent with fileToModule semantics)
      if (!map.has(filePath)) {
        map.set(filePath, mod.id);
      }
    }
  }
  return map;
}

/**
 * Look up the owning module for an import path using the file-to-module map.
 *
 * Tries the resolved path directly, then with common file extensions appended.
 * Returns the first matching module ID or null.
 *
 * @param {string} resolved - Resolved import path (relative to project root)
 * @param {Map<string, string>} fileToModuleMap - Pre-computed map
 * @returns {string | null} Module ID or null if no match
 */
function lookupModuleForImport(resolved, fileToModuleMap) {
  for (const ext of IMPORT_EXTENSIONS) {
    const candidate = resolved + ext;
    const moduleId = fileToModuleMap.get(candidate);
    if (moduleId) return moduleId;
  }
  return null;
}

/**
 * Build external refs map for a single file's imports using pre-computed fileToModuleMap.
 *
 * AC-2: O(1) lookups per import via fileToModuleMap. Extracted to avoid duplication
 * between incremental and full generation paths.
 *
 * @param {{ filePath: string, imports: Array<{ source: string, symbols: string[] }> }} file - Analyzed file
 * @param {{ id: string }} mod - Module config (used to exclude self-references)
 * @param {Map<string, string>} fileToModuleMap - Pre-computed file-to-module map
 * @returns {Record<string, string[]>} Map of target module ID to imported symbols (empty if none)
 */
function buildExternalRefsForFile(file, mod, fileToModuleMap) {
  const refs = {};
  for (const imp of file.imports) {
    if (!imp.source.startsWith('.') && !imp.source.startsWith('/')) continue;
    const importDir = file.filePath.includes('/')
      ? file.filePath.substring(0, file.filePath.lastIndexOf('/'))
      : '.';
    const resolved = resolveImportPath(importDir, imp.source);
    if (!resolved) continue;

    // O(1) lookup: try resolved path directly and with common extensions
    const targetModuleId = lookupModuleForImport(resolved, fileToModuleMap);
    if (targetModuleId && targetModuleId !== mod.id) {
      if (!refs[targetModuleId]) refs[targetModuleId] = [];
      for (const sym of imp.symbols) {
        if (!refs[targetModuleId].includes(sym)) {
          refs[targetModuleId].push(sym);
        }
      }
    }
  }
  return refs;
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
 * M2 (REQ-005, REQ-009): Supports incremental mode via staleness.json.
 * When `incremental: true` is set and staleness.json exists, only regenerates
 * stale files. Use `full: true` to force complete regeneration.
 * Default behavior (no incremental/full flag) is full generation for backward
 * compatibility. After generation, always updates staleness.json with new hashes.
 *
 * @param {object} [options]
 * @param {string} [options.targetModuleId] - If provided, generate only this module's low-level trace + update high-level
 * @param {string} [options.projectRoot] - Project root override
 * @param {boolean} [options.lowLevelOnly] - Skip high-level trace generation
 * @param {boolean} [options.full] - Force full regeneration, ignoring staleness state (REQ-009)
 * @param {boolean} [options.incremental] - Enable incremental mode using staleness.json (REQ-005)
 * @param {number} [options.parallelWorkers=0] - Number of worker threads for parallel module analysis (AC-7, 0 = sequential)
 * @param {boolean} [options.skipArchitecture] - Skip architecture.yaml generation from trace config
 * @returns {{ modulesProcessed: number, filesGenerated: number, durationMs: number, lowLevelResults: Array, highLevelVersion: number | null, incremental: boolean, architectureBridge?: { written: boolean, moduleCount: number, path: string } }}
 */
export async function generateAllTraces(options = {}) {
  const startTime = Date.now();
  const root = options.projectRoot || resolveProjectRoot();
  const targetModuleId = options.targetModuleId || undefined;
  const lowLevelOnly = options.lowLevelOnly || false;
  const forceFull = options.full || false;
  const requestIncremental = options.incremental || false;
  const parallelWorkers = options.parallelWorkers != null ? options.parallelWorkers : 0;
  const skipArchitecture = options.skipArchitecture || false;

  // AC-5.3: Ensure directory structure exists
  const tracesDir = join(root, '.claude', 'traces');
  const lowLevelDir = join(tracesDir, 'low-level');
  mkdirSync(lowLevelDir, { recursive: true });

  let filesGenerated = 0;
  let highLevelVersion = null;
  let incremental = false;

  // M2: Attempt incremental generation if explicitly requested AND staleness.json exists
  // AND --full not set AND no target module specified
  const useIncremental = requestIncremental && !forceFull && !targetModuleId;
  const stalenessResult = useIncremental ? loadStalenessMetadata(root) : null;

  if (stalenessResult) {
    // Incremental mode: only regenerate stale files
    incremental = true;
    const config = loadTraceConfig(root);
    const knownExports = buildExportIndex(config, root);
    // AC-2: Build file-to-module map for O(1) external ref resolution
    const fileToModuleMap = buildFileToModuleMap(config, root);
    const stalenessData = stalenessResult.data;
    const lowLevelResults = [];
    let modulesProcessed = 0;

    for (const mod of config.modules) {
      // Find stale files in this module
      const matchingFiles = findFilesMatchingGlobs(mod.fileGlobs, root);
      matchingFiles.sort();

      const staleFiles = matchingFiles.filter(f =>
        isFileStale(f, mod.id, stalenessData, root)
      );

      if (staleFiles.length === 0) {
        // No stale files -- skip this module entirely
        continue;
      }

      // Collect export signatures BEFORE regeneration for comparison
      const oldExportSigHash = stalenessData.modules[mod.id]
        ? stalenessData.modules[mod.id].exportSignatureHash
        : '';

      // Regenerate the entire module trace (containing both stale and fresh files)
      // The trace file is per-module, so we regenerate it fully but only because
      // at least one file changed. The staleness.json tracks per-file hashes.
      const result = writeLowLevelTrace(mod, config, root, knownExports);
      lowLevelResults.push(result);
      modulesProcessed++;
      filesGenerated += 3; // .json + .md + .calls.json

      // Update staleness.json for this module's files
      if (!stalenessData.modules[mod.id]) {
        stalenessData.modules[mod.id] = { files: {}, exportSignatureHash: '' };
      }

      // Read the just-generated trace to get current exports
      const tracePath = join(lowLevelDir, `${mod.id}.json`);
      let traceData;
      try {
        traceData = JSON.parse(readFileSync(tracePath, 'utf-8'));
      } catch {
        continue;
      }

      // Collect all exports from the module for signature hash
      const allModuleExports = [];
      const now = formatTimestamp();

      for (const file of traceData.files) {
        allModuleExports.push(...file.exports);

        // Update per-file hash in staleness data
        try {
          const absPath = join(root, file.filePath);
          // AC-5: Pass cached content to avoid redundant file reads for hashing
          const cachedContent = fileContentCache.get(absPath) || null;
          const fileHash = computeFileHash(absPath, cachedContent);
          stalenessData.modules[mod.id].files[file.filePath] = {
            hash: fileHash,
            lastTraced: now,
            ...(stalenessData.modules[mod.id].files[file.filePath]?.externalRefs
              ? { externalRefs: stalenessData.modules[mod.id].files[file.filePath].externalRefs }
              : {}),
          };
        } catch {
          // File may not exist -- skip
        }
      }

      // AC-2: Build externalRefs using pre-computed fileToModuleMap for O(1) lookups
      for (const file of traceData.files) {
        const refs = buildExternalRefsForFile(file, mod, fileToModuleMap);
        if (Object.keys(refs).length > 0 && stalenessData.modules[mod.id].files[file.filePath]) {
          stalenessData.modules[mod.id].files[file.filePath].externalRefs = refs;
        }
      }

      // Compute new export signature hash and propagate if changed
      const newExportSigHash = computeExportSignatureHash(allModuleExports);
      propagateCrossModuleStaleness(mod.id, stalenessData, newExportSigHash);
    }

    // Write staleness.json AFTER all trace files (REQ-012: write ordering)
    writeStalenessMetadata(stalenessData, root);

    // Generate high-level trace if needed
    if (!lowLevelOnly && modulesProcessed > 0) {
      const lowLevelTraces = [];
      for (const mod of config.modules) {
        const tracePath = join(root, LOW_LEVEL_TRACE_DIR, `${mod.id}.json`);
        try {
          const traceData = JSON.parse(readFileSync(tracePath, 'utf-8'));
          lowLevelTraces.push(traceData);
        } catch {
          // skip
        }
      }

      const { dependencyData, skippedFiles } = aggregateDependencies(lowLevelTraces, config);
      const highLevelResult = generateHighLevelTrace({
        projectRoot: root,
        config,
        dependencyData,
        skippedFiles,
      });
      highLevelVersion = highLevelResult.version;
      filesGenerated += 2;
    }

    // Architecture bridge: generate architecture.yaml from trace config
    let architectureBridge;
    if (!skipArchitecture) {
      const traceConfig = loadTraceConfig(root);
      architectureBridge = generateArchitectureFromTrace(traceConfig, root);
    }

    // Clear file content cache after generation run to free memory
    fileContentCache.clear();
    resetFileCache();

    const durationMs = Date.now() - startTime;
    return {
      modulesProcessed,
      filesGenerated,
      durationMs,
      lowLevelResults,
      highLevelVersion,
      incremental: true,
      ...(architectureBridge ? { architectureBridge } : {}),
    };
  }

  // Full generation mode (original behavior, or --full, or no staleness.json)

  // Step 1: Generate low-level traces for all modules (or target module)
  // Must happen before high-level trace so dependency aggregation has import data.
  const { modulesProcessed, results: lowLevelResults } = await generateAllLowLevelTraces(targetModuleId, root, parallelWorkers);
  filesGenerated += lowLevelResults.length * 3; // .json + .md + .calls.json per module

  // Step 2: Build/rebuild staleness.json from the generated traces
  const config = loadTraceConfig(root);
  // AC-2: Build file-to-module map for O(1) external ref resolution
  const fileToModuleMap = buildFileToModuleMap(config, root);
  const newStalenessData = createEmptyStalenessData();

  for (const mod of config.modules) {
    const tracePath = join(root, LOW_LEVEL_TRACE_DIR, `${mod.id}.json`);
    let traceData;
    try {
      traceData = JSON.parse(readFileSync(tracePath, 'utf-8'));
    } catch {
      continue;
    }

    const allModuleExports = [];
    const moduleFiles = {};
    const now = formatTimestamp();

    for (const file of traceData.files) {
      allModuleExports.push(...file.exports);

      try {
        const absPath = join(root, file.filePath);
        // AC-5: Pass cached content to avoid redundant file reads for hashing
        const cachedContent = fileContentCache.get(absPath) || null;
        const fileHash = computeFileHash(absPath, cachedContent);
        const fileEntry = {
          hash: fileHash,
          lastTraced: now,
        };

        // AC-2: Build externalRefs using pre-computed fileToModuleMap for O(1) lookups
        const refs = buildExternalRefsForFile(file, mod, fileToModuleMap);
        if (Object.keys(refs).length > 0) {
          fileEntry.externalRefs = refs;
        }

        moduleFiles[file.filePath] = fileEntry;
      } catch {
        // File hash computation failed -- skip
      }
    }

    newStalenessData.modules[mod.id] = {
      files: moduleFiles,
      exportSignatureHash: computeExportSignatureHash(allModuleExports),
    };
  }

  // Write staleness.json AFTER all trace files (REQ-012: write ordering)
  writeStalenessMetadata(newStalenessData, root);

  // Step 3: Generate high-level trace with dependency aggregation (unless --low-level-only)
  if (!lowLevelOnly) {
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

  // Architecture bridge: generate architecture.yaml from trace config
  let architectureBridge;
  if (!skipArchitecture) {
    architectureBridge = generateArchitectureFromTrace(config, root);
  }

  // Clear file content cache after generation run to free memory
  fileContentCache.clear();
  resetFileCache();

  const durationMs = Date.now() - startTime;

  return {
    modulesProcessed,
    filesGenerated,
    durationMs,
    lowLevelResults,
    highLevelVersion,
    incremental: false,
    ...(architectureBridge ? { architectureBridge } : {}),
  };
}

/**
 * Resolve a relative import path against an importing directory (for staleness tracking).
 *
 * Simplified version of resolveImportPath for cross-module reference detection.
 *
 * @param {string} fromDir - Directory of the importing file
 * @param {string} importPath - Import specifier
 * @returns {string | null} Resolved path or null
 */

// =============================================================================
// Architecture Bridge: Generate architecture.yaml from trace.config.json
// =============================================================================

/**
 * Find the longest common path prefix of an array of glob patterns.
 *
 * Strips glob-specific characters (*, ?, {, }) and finds the common directory prefix.
 * Returns the common prefix with `/**` appended.
 *
 * @param {string[]} globs - Array of file glob patterns
 * @returns {string} Common parent directory with `/**` suffix
 */
export function findCommonGlobPrefix(globs) {
  if (!globs || globs.length === 0) return '**';

  // Extract the directory portion of each glob (before any glob chars)
  const directories = globs.map(g => {
    // Find the first glob character
    const firstGlob = Math.min(
      ...[g.indexOf('*'), g.indexOf('?'), g.indexOf('{')]
        .filter(i => i !== -1)
        .concat([g.length]) // fallback: no glob chars => use full length
    );
    // Take the substring up to the first glob char, then get the directory part
    const prefix = g.substring(0, firstGlob);
    // Remove trailing filename component (everything after last /)
    const lastSlash = prefix.lastIndexOf('/');
    return lastSlash >= 0 ? prefix.substring(0, lastSlash) : '';
  });

  if (directories.length === 0) return '**';

  // Find the longest common prefix among the directory paths
  let common = directories[0];
  for (let i = 1; i < directories.length; i++) {
    while (!directories[i].startsWith(common)) {
      const lastSlash = common.lastIndexOf('/');
      if (lastSlash < 0) {
        common = '';
        break;
      }
      common = common.substring(0, lastSlash);
    }
  }

  return common ? `${common}/**` : '**';
}

/**
 * Generate architecture.yaml content from trace.config.json modules.
 *
 * Transforms each trace module into the architecture.yaml format:
 * - name: module.name
 * - id: module.id (for traceability)
 * - description: module.description
 * - path: consolidated common parent of fileGlobs + /**
 * - responsibilities: [module.description] (single-item array)
 * - depends_on: [] (default, no dependency info in trace config)
 *
 * Only overwrites architecture.yaml if content has actually changed.
 *
 * @param {{ modules: Array<{ id: string, name: string, description: string, fileGlobs: string[] }> }} traceConfig - Parsed trace.config.json
 * @param {string} projectRoot - Absolute path to project root
 * @returns {{ written: boolean, moduleCount: number, path: string }} Result summary
 */
export function generateArchitectureFromTrace(traceConfig, projectRoot) {
  const archDoc = {
    schema_version: 1,
    modules: traceConfig.modules.map(mod => ({
      name: mod.name,
      id: mod.id,
      description: mod.description,
      path: findCommonGlobPrefix(mod.fileGlobs),
      responsibilities: [mod.description],
      depends_on: [],
    })),
  };

  const header = [
    '# Auto-generated from trace.config.json — do not edit manually',
    '# Regenerate with: node .claude/scripts/trace-generate.mjs --full',
    '',
  ].join('\n');

  const yamlStr = YAML.stringify(archDoc, {
    lineWidth: 120,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
  });

  const content = header + yamlStr;

  const docsDir = join(projectRoot, '.claude', 'docs', 'structured');
  mkdirSync(docsDir, { recursive: true });
  const archPath = join(docsDir, 'architecture.yaml');

  // Only overwrite if content has changed
  let existing = '';
  try {
    existing = readFileSync(archPath, 'utf-8');
  } catch {
    // File does not exist yet
  }

  if (existing === content) {
    return { written: false, moduleCount: archDoc.modules.length, path: archPath };
  }

  writeFileSync(archPath, content);
  return { written: true, moduleCount: archDoc.modules.length, path: archPath };
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
  // Skip args that are values for --parallel flag
  const parallelValueIdx = args.indexOf('--parallel') !== -1 ? args.indexOf('--parallel') + 1 : -1;
  const targetModule = args.find((a, i) => !a.startsWith('--') && i !== parallelValueIdx);
  const lowLevelOnly = args.includes('--low-level-only');
  const bootstrapFlag = args.includes('--bootstrap');
  const fullFlag = args.includes('--full');
  const incrementalFlag = args.includes('--incremental');
  const skipArchitectureFlag = args.includes('--skip-architecture');

  // AC-7: Parse --parallel flag (default: auto, 0 = sequential)
  let parallelWorkers = Math.min(cpus().length, DEFAULT_MAX_WORKERS);
  const parallelIdx = args.indexOf('--parallel');
  if (parallelIdx !== -1 && args[parallelIdx + 1] !== undefined) {
    parallelWorkers = parseInt(args[parallelIdx + 1], 10);
    if (Number.isNaN(parallelWorkers) || parallelWorkers < 0) {
      parallelWorkers = Math.min(cpus().length, DEFAULT_MAX_WORKERS);
    }
  }

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

    // AC-3: CLI defaults to incremental mode. Use --full for complete regeneration.
    // --incremental is a no-op (already the default) but kept for explicitness.
    const result = await generateAllTraces({
      targetModuleId: targetModule,
      lowLevelOnly,
      full: fullFlag,
      incremental: !fullFlag,
      parallelWorkers,
      skipArchitecture: skipArchitectureFlag,
    });

    // AC-5.4: Output summary reporting modules processed and files generated
    const modeLabel = targetModule
      ? `Trace generation complete (module: ${targetModule}).`
      : 'Trace generation complete.';
    console.log(modeLabel);
    console.log(`  Mode: ${result.incremental ? 'incremental' : 'full'}`);
    console.log(`  Modules processed: ${result.modulesProcessed}`);
    console.log(`  Files generated: ${result.filesGenerated}`);
    console.log(`  Duration: ${result.durationMs}ms`);
    if (result.highLevelVersion !== null) {
      console.log(`  High-level trace: version ${result.highLevelVersion}`);
    }
    for (const r of result.lowLevelResults) {
      console.log(`  ${r.moduleId}: ${r.fileCount} files, version ${r.version}`);
    }
    if (result.architectureBridge) {
      const ab = result.architectureBridge;
      console.log(`  Architecture bridge: ${ab.moduleCount} modules${ab.written ? ' (updated)' : ' (unchanged)'}`);
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
