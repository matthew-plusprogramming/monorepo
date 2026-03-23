/**
 * TypeScript Compiler API-based Analyzer Module
 *
 * Replaces regex-based parseImports, parseExports, parseCallGraph, and
 * parseEventPatterns with TypeScript compiler API equivalents using AST walking.
 *
 * Implements: REQ-020 (TypeScript Compiler API Replacement)
 *
 * Key benefits over regex:
 *   - Accurate call graph (handles destructuring, nested calls, method chains)
 *   - Better import resolution (dynamic imports, re-exports)
 *   - Correct function signature capture (handles complex parameter patterns)
 *   - No false positives from strings/comments containing function-like patterns
 *
 * The return shapes are identical to the regex-based functions in trace-generate.mjs,
 * enabling a drop-in swap (REQ-021).
 */

import ts from 'typescript';

// =============================================================================
// Constants
// =============================================================================

/** Maximum length for display-facing signature field */
const SIGNATURE_DISPLAY_MAX_LENGTH = 200;

/** Maximum length for raw signature field (hard cap) */
const SIGNATURE_RAW_MAX_LENGTH = 500;

/** JavaScript keywords to exclude from call detection */
const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'new', 'typeof', 'instanceof',
  'void', 'delete', 'in', 'of', 'class', 'function', 'async', 'await',
  'import', 'export', 'from', 'const', 'let', 'var', 'super', 'this',
  'yield', 'with', 'debugger', 'default', 'extends', 'static',
]);

/** Emit method names for event pattern detection */
const EMIT_METHODS = new Set(['emit', 'dispatch', 'trigger']);

/** Subscribe method names for event pattern detection */
const SUBSCRIBE_METHODS = new Set(['on', 'addEventListener', 'subscribe', 'once', 'addListener']);

// =============================================================================
// Utility Functions
// =============================================================================

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
 * Create a TypeScript SourceFile from source text.
 *
 * Uses ts.ScriptKind.JS to handle .mjs files natively.
 * Sets setParentNodes: true to enable AST traversal with parent references.
 *
 * @param {string} filePath - File path (used for error messages and ScriptKind inference)
 * @param {string} sourceText - Source code text
 * @returns {ts.SourceFile}
 */
function createSourceFileFromText(filePath, sourceText) {
  // Determine script kind based on extension
  let scriptKind = ts.ScriptKind.JS;
  if (filePath.endsWith('.ts')) {
    scriptKind = ts.ScriptKind.TS;
  } else if (filePath.endsWith('.tsx')) {
    scriptKind = ts.ScriptKind.TSX;
  } else if (filePath.endsWith('.jsx')) {
    scriptKind = ts.ScriptKind.JSX;
  }

  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,  // setParentNodes
    scriptKind,
  );
}

/**
 * Get 1-indexed line number for a position in a SourceFile.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {number} pos - Character position
 * @returns {number} 1-indexed line number
 */
function getLineNumber(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

// =============================================================================
// Import Analysis (REQ-020)
// =============================================================================

/**
 * Parse import statements from source code using TypeScript compiler API.
 *
 * Handles all import forms:
 * - import { X, Y } from 'source'
 * - import X from 'source'
 * - import * as X from 'source'
 * - import type { X } from 'source'
 * - import 'source' (side-effect)
 * - const X = require('source') (CJS)
 *
 * Return shape matches regex parseImports: Array<{ source: string, symbols: string[] }>
 *
 * @param {string} source - File source code
 * @returns {Array<{ source: string, symbols: string[] }>}
 */
export function parseImportsTS(source) {
  const imports = [];
  const sourceFile = createSourceFileFromText('analysis.mjs', source);

  ts.forEachChild(sourceFile, function visit(node) {
    // Handle: import ... from 'source'
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (!ts.isStringLiteral(moduleSpecifier)) return;

      const importSource = moduleSpecifier.text;
      const symbols = [];

      const importClause = node.importClause;
      if (importClause) {
        // Default import: import X from 'source'
        if (importClause.name) {
          symbols.push(importClause.name.text);
        }

        const namedBindings = importClause.namedBindings;
        if (namedBindings) {
          if (ts.isNamespaceImport(namedBindings)) {
            // import * as X from 'source'
            symbols.push(`* as ${namedBindings.name.text}`);
          } else if (ts.isNamedImports(namedBindings)) {
            // import { X, Y as Z } from 'source'
            for (const element of namedBindings.elements) {
              // Use the local name (the "as" alias if present)
              symbols.push(element.name.text);
            }
          }
        }
      }
      // If no importClause, it's a side-effect import: import 'source'
      imports.push({ source: importSource, symbols });
      return;
    }

    // Handle: const X = require('source')
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const callExpr = decl.initializer;
          if (ts.isIdentifier(callExpr.expression) && callExpr.expression.text === 'require') {
            if (callExpr.arguments.length > 0 && ts.isStringLiteral(callExpr.arguments[0])) {
              const importSource = callExpr.arguments[0].text;
              const symbols = [];

              if (ts.isObjectBindingPattern(decl.name)) {
                // const { X, Y } = require('source')
                for (const element of decl.name.elements) {
                  if (ts.isIdentifier(element.name)) {
                    symbols.push(element.name.text);
                  }
                }
              } else if (ts.isIdentifier(decl.name)) {
                // const X = require('source')
                symbols.push(decl.name.text);
              }

              imports.push({ source: importSource, symbols });
            }
          }
        }
      }
    }
  });

  return imports;
}

// =============================================================================
// Export Analysis (REQ-020)
// =============================================================================

/**
 * Extract function signature text from a function declaration node.
 *
 * Captures parameters and return type annotation.
 *
 * @param {ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction} node
 * @param {ts.SourceFile} sourceFile
 * @returns {{ signature: string, signatureRaw: string }}
 */
function extractSignature(node, sourceFile) {
  if (!node.parameters) {
    return { signature: '', signatureRaw: '' };
  }

  // Build parameter list
  const params = node.parameters.map(p => {
    const paramText = p.getText(sourceFile);
    return paramText;
  });

  let sigText = `(${params.join(', ')})`;

  // Add return type if present
  if (node.type) {
    sigText += `: ${node.type.getText(sourceFile)}`;
  }

  const collapsed = sigText.replace(/\s+/g, ' ').trim();
  const signatureRaw = truncateWithEllipsis(collapsed, SIGNATURE_RAW_MAX_LENGTH);
  const signature = truncateWithEllipsis(collapsed, SIGNATURE_DISPLAY_MAX_LENGTH);

  return { signature, signatureRaw };
}

/**
 * Parse export statements from source code using TypeScript compiler API.
 *
 * Handles all export forms:
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
 * Return shape matches regex parseExports:
 *   Array<{ symbol: string, type: string, lineNumber: number, signature: string, signatureRaw: string }>
 *
 * @param {string} source - File source code
 * @returns {Array<{ symbol: string, type: string, lineNumber: number, signature: string, signatureRaw: string }>}
 */
export function parseExportsTS(source) {
  const exports = [];
  const seen = new Set();
  const sourceFile = createSourceFileFromText('analysis.mjs', source);

  ts.forEachChild(sourceFile, function visit(node) {
    // Export declarations: export { X, Y } or export { X, Y } from 'source'
    if (ts.isExportDeclaration(node)) {
      const lineNumber = getLineNumber(sourceFile, node.getStart(sourceFile));
      const isTypeExport = node.isTypeOnly;

      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const symbol = element.name.text;
          if (!seen.has(symbol)) {
            seen.add(symbol);
            exports.push({
              symbol,
              type: isTypeExport ? 'type' : 'const',
              lineNumber,
              signature: '',
              signatureRaw: '',
            });
          }
        }
      }
      return;
    }

    // Export assignment: export default ...
    if (ts.isExportAssignment(node)) {
      const lineNumber = getLineNumber(sourceFile, node.getStart(sourceFile));
      let symbol = 'default';
      let signature = '';
      let signatureRaw = '';

      if (ts.isIdentifier(node.expression)) {
        symbol = node.expression.text;
      } else if (ts.isFunctionExpression(node.expression) && node.expression.name) {
        symbol = node.expression.name.text;
        const sig = extractSignature(node.expression, sourceFile);
        signature = sig.signature;
        signatureRaw = sig.signatureRaw;
      } else if (ts.isClassExpression(node.expression) && node.expression.name) {
        symbol = node.expression.name.text;
      }

      if (!seen.has('default')) {
        seen.add('default');
        exports.push({ symbol, type: 'default', lineNumber, signature, signatureRaw });
      }
      return;
    }

    // Check for exported declarations via modifiers
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const hasExport = modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    const hasDefault = modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);

    if (!hasExport) return;

    const lineNumber = getLineNumber(sourceFile, node.getStart(sourceFile));

    // export default function name() / export default class Name
    if (hasDefault) {
      let symbol = 'default';
      let signature = '';
      let signatureRaw = '';

      if (ts.isFunctionDeclaration(node) && node.name) {
        symbol = node.name.text;
        const sig = extractSignature(node, sourceFile);
        signature = sig.signature;
        signatureRaw = sig.signatureRaw;
      } else if (ts.isClassDeclaration(node) && node.name) {
        symbol = node.name.text;
      } else if (ts.isFunctionDeclaration(node)) {
        // export default function() {} -- anonymous
        const sig = extractSignature(node, sourceFile);
        signature = sig.signature;
        signatureRaw = sig.signatureRaw;
      }

      if (!seen.has('default')) {
        seen.add('default');
        exports.push({ symbol, type: 'default', lineNumber, signature, signatureRaw });
      }
      return;
    }

    // export function name()
    if (ts.isFunctionDeclaration(node) && node.name) {
      const symbol = node.name.text;
      const sig = extractSignature(node, sourceFile);

      // Support overloaded functions: allow multiple entries for same symbol
      // when they have different signatures (overload declarations have no body)
      const isOverloadDecl = !node.body;

      if (isOverloadDecl || !seen.has(symbol)) {
        if (!isOverloadDecl) {
          seen.add(symbol);
        }
        exports.push({
          symbol,
          type: 'function',
          lineNumber,
          signature: sig.signature,
          signatureRaw: sig.signatureRaw,
        });
      }
      return;
    }

    // export class Name
    if (ts.isClassDeclaration(node) && node.name) {
      const symbol = node.name.text;
      if (!seen.has(symbol)) {
        seen.add(symbol);
        exports.push({ symbol, type: 'class', lineNumber, signature: '', signatureRaw: '' });
      }
      return;
    }

    // export interface Name
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const symbol = node.name.text;
      if (!seen.has(symbol)) {
        seen.add(symbol);
        exports.push({ symbol, type: 'interface', lineNumber, signature: '', signatureRaw: '' });
      }
      return;
    }

    // export type Name = ...
    if (ts.isTypeAliasDeclaration(node) && node.name) {
      const symbol = node.name.text;
      if (!seen.has(symbol)) {
        seen.add(symbol);
        exports.push({ symbol, type: 'type', lineNumber, signature: '', signatureRaw: '' });
      }
      return;
    }

    // export enum Name
    if (ts.isEnumDeclaration(node) && node.name) {
      const symbol = node.name.text;
      if (!seen.has(symbol)) {
        seen.add(symbol);
        exports.push({ symbol, type: 'enum', lineNumber, signature: '', signatureRaw: '' });
      }
      return;
    }

    // export const/let/var name = ...
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const symbol = decl.name.text;
          if (!seen.has(symbol)) {
            seen.add(symbol);
            exports.push({ symbol, type: 'const', lineNumber, signature: '', signatureRaw: '' });
          }
        }
      }
      return;
    }
  });

  return exports;
}

// =============================================================================
// Call Graph Analysis (REQ-020)
// =============================================================================

/**
 * Get the resolved function name from a call expression.
 *
 * Handles:
 * - Simple calls: foo()
 * - Method calls: obj.foo()
 * - Chained calls: a.b.c() -> returns 'c'
 *
 * @param {ts.CallExpression} node
 * @returns {string | null} The function name or null if not resolvable
 */
function getCalleeNameFromExpression(node) {
  const expr = node.expression;

  // Simple identifier call: foo()
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }

  // Property access: obj.foo() or a.b.c()
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text;
  }

  return null;
}

/**
 * Parse function call patterns from source code using TypeScript compiler API.
 *
 * Walks the AST to find all CallExpression nodes. Resolves callees against
 * the importMap (imported symbols) and knownExports (all known exports from
 * traced modules). Unresolved callees get calleeFile: null, calleeLine: null.
 *
 * Return shape matches regex parseCallGraph:
 *   Array<{ callerFile: string, callerLine: number, calleeName: string, calleeFile: string|null, calleeLine: number|null }>
 *
 * @param {string} source - File source code
 * @param {Array<{ source: string, symbols: string[] }>} importMap - Parsed imports from this file
 * @param {Map<string, { file: string, line: number }>} knownExports - Cross-module export index
 * @param {string} filePath - Relative path of the file being analyzed (for callerFile)
 * @returns {Array<{ callerFile: string, callerLine: number, calleeName: string, calleeFile: string|null, calleeLine: number|null }>}
 */
export function parseCallGraphTS(source, importMap, knownExports, filePath) {
  const calls = [];
  const seen = new Set(); // Deduplicate: "callerLine:calleeName"
  const sourceFile = createSourceFileFromText(filePath || 'analysis.mjs', source);

  // Build a map of imported symbol -> source module path for resolution
  const importedSymbolToSource = new Map();
  for (const imp of importMap) {
    for (const sym of imp.symbols) {
      if (sym.startsWith('* as ')) continue;
      importedSymbolToSource.set(sym, imp.source);
    }
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const calleeName = getCalleeNameFromExpression(node);

      if (calleeName && !JS_KEYWORDS.has(calleeName)) {
        const lineNumber = getLineNumber(sourceFile, node.getStart(sourceFile));

        // Check if this call is within an import/export declaration -- skip those
        let parent = node.parent;
        let isImportExport = false;
        while (parent) {
          if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
            isImportExport = true;
            break;
          }
          parent = parent.parent;
        }
        if (isImportExport) {
          ts.forEachChild(node, visit);
          return;
        }

        const dedupKey = `${lineNumber}:${calleeName}`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);

          // Resolve callee
          let calleeFile = null;
          let calleeLine = null;

          if (importedSymbolToSource.has(calleeName)) {
            const exportInfo = knownExports.get(calleeName);
            if (exportInfo) {
              calleeFile = exportInfo.file;
              calleeLine = exportInfo.line;
            }
          } else {
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
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return calls;
}

// =============================================================================
// Event Pattern Detection (REQ-020)
// =============================================================================

/**
 * Parse event emit/subscribe patterns from source code using TypeScript compiler API.
 *
 * Detects patterns like:
 *   - obj.emit('eventName', ...)
 *   - obj.on('eventName', ...)
 *   - obj.addEventListener('eventName', ...)
 *   - obj.subscribe('eventName', ...)
 *   - obj.once('eventName', ...)
 *   - obj.addListener('eventName', ...)
 *
 * Return shape matches regex parseEventPatterns:
 *   Array<{ file: string, line: number, eventName: string, type: "emit"|"subscribe" }>
 *
 * @param {string} source - File source code
 * @param {string} filePath - Relative path of the file being analyzed
 * @returns {Array<{ file: string, line: number, eventName: string, type: "emit"|"subscribe" }>}
 */
export function parseEventPatternsTS(source, filePath) {
  const events = [];
  const sourceFile = createSourceFileFromText(filePath || 'analysis.mjs', source);

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;

      // Check if this is an event method
      let type = null;
      if (EMIT_METHODS.has(methodName)) {
        type = 'emit';
      } else if (SUBSCRIBE_METHODS.has(methodName)) {
        type = 'subscribe';
      }

      if (type && node.arguments.length > 0) {
        const firstArg = node.arguments[0];
        // Only capture string literal event names
        if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
          const eventName = firstArg.text;
          const lineNumber = getLineNumber(sourceFile, node.getStart(sourceFile));

          events.push({
            file: filePath,
            line: lineNumber,
            eventName,
            type,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return events;
}

// =============================================================================
// Unified Analyzer Interface (REQ-021)
// =============================================================================

/**
 * Analyze source code using TypeScript compiler API.
 *
 * This is the TS compiler equivalent of the regex-based analysis pipeline.
 * It accepts the same inputs and returns the same shape as the regex versions,
 * enabling a drop-in swap.
 *
 * @param {string} source - File source code
 * @param {string} filePath - Relative file path
 * @param {Map<string, { file: string, line: number }>} knownExports - Cross-module export index
 * @returns {{ exports: Array, imports: Array, calls: Array, events: Array }}
 */
export function analyzeSourceWithCompiler(source, filePath, knownExports) {
  const exports = parseExportsTS(source);
  const imports = parseImportsTS(source);
  const calls = parseCallGraphTS(source, imports, knownExports || new Map(), filePath);
  const events = parseEventPatternsTS(source, filePath);

  return { exports, imports, calls, events };
}
