/**
 * Import / Re-export AST Extractor for Pure-Compute Static Check
 *
 * Parses a TypeScript/JavaScript file via the TypeScript compiler API and
 * returns the set of outgoing edges:
 *   - static `import` declarations (with isTypeOnly, binding names)
 *   - re-exports (`export * from ...`, `export { x } from ...`)
 *   - dynamic `import(...)` call expressions
 *   - type-only import count (for filtering downstream traversal)
 *
 * Does NOT resolve specifiers and does NOT match the blocklist. Pure AST
 * transform; the walker owns resolution + blocklist logic.
 *
 * Parse failures return a structured record instead of throwing so the walker
 * can emit `<parse-error>` violations per AC6.13.
 *
 * Spec: sg-e2e-pure-compute-check atomic as-003 (Task T3; EC-PCC-7, EC-PCC-9, EC-PCC-16)
 * Requirements: REQ-F-011 (re-exports followed; type-only filtered; dynamic import captured)
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';

// =============================================================================
// Public API
// =============================================================================

/**
 * @typedef {Object} ImportRecord
 * @property {string} specifier - The raw import specifier text
 * @property {Array<{kind: 'default'|'named'|'namespace', local: string, imported?: string, isTypeOnly?: boolean}>} nameBindings
 * @property {boolean} isTypeOnly - Whether the entire declaration is `import type`
 * @property {{line: number, column: number}} span - 1-indexed line/column
 *
 * @typedef {Object} ReexportRecord
 * @property {string} specifier - The moduleSpecifier of the export declaration
 * @property {'star'|'named'} kind - `export *` vs `export { x }`
 * @property {Array<{local: string, imported?: string}>} nameBindings - Named-export bindings
 * @property {{line: number, column: number}} span
 *
 * @typedef {Object} DynamicImportRecord
 * @property {string} argText - The raw text of the import(...) argument
 * @property {{line: number, column: number}} span
 *
 * @typedef {Object} ExtractorResult
 * @property {ImportRecord[]} imports
 * @property {ReexportRecord[]} reexports
 * @property {DynamicImportRecord[]} dynamicImports
 * @property {number} typeOnlyCount
 * @property {{kind: 'parse-error', message: string}|null} parseError
 */

/**
 * Extract imports, re-exports, and dynamic-import call sites from a file.
 *
 * @param {string} filePath - Absolute path to the source file
 * @returns {ExtractorResult}
 */
export function extractImports(filePath) {
  let source;
  try {
    source = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      imports: [],
      reexports: [],
      dynamicImports: [],
      typeOnlyCount: 0,
      parseError: { kind: 'parse-error', message: `read failed: ${err.message}` },
    };
  }

  return extractFromSource(source, filePath);
}

/**
 * Same as `extractImports` but takes source text directly; for in-memory tests.
 *
 * @param {string} source
 * @param {string} filePath
 * @returns {ExtractorResult}
 */
export function extractFromSource(source, filePath) {
  const imports = [];
  const reexports = [];
  const dynamicImports = [];
  let typeOnlyCount = 0;
  let parseError = null;

  const scriptKind = inferScriptKind(filePath);
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );

  // TypeScript's createSourceFile always succeeds (it's a tolerant parser), but
  // we surface any syntax-level diagnostics as a parse-error record per AC3.6
  // so the walker can still run and emit fail-closed violations.
  const syntacticDiagnostics = sourceFile.parseDiagnostics || [];
  if (syntacticDiagnostics.length > 0) {
    const first = syntacticDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(first.messageText, '\n');
    parseError = { kind: 'parse-error', message };
    // Continue walking anyway -- partial AST may still yield useful records.
  }

  function span(node) {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: pos.line + 1, column: pos.character + 1 };
  }

  function visit(node) {
    // Static imports: `import x from 'y'`, `import { a, type B } from 'y'`, etc.
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        ts.forEachChild(node, visit);
        return;
      }
      const specifier = node.moduleSpecifier.text;
      const importClause = node.importClause;
      const isTypeOnly = Boolean(importClause && importClause.isTypeOnly);
      const nameBindings = [];

      if (importClause) {
        // Default import: `import Foo from 'y'`
        if (importClause.name) {
          nameBindings.push({
            kind: 'default',
            local: importClause.name.text,
            isTypeOnly: isTypeOnly,
          });
        }
        if (importClause.namedBindings) {
          if (ts.isNamespaceImport(importClause.namedBindings)) {
            // `import * as ns from 'y'`
            nameBindings.push({
              kind: 'namespace',
              local: importClause.namedBindings.name.text,
              isTypeOnly: isTypeOnly,
            });
          } else if (ts.isNamedImports(importClause.namedBindings)) {
            for (const element of importClause.namedBindings.elements) {
              nameBindings.push({
                kind: 'named',
                local: element.name.text,
                imported: element.propertyName ? element.propertyName.text : element.name.text,
                // Per-specifier type flag: `import { type X }`
                isTypeOnly: Boolean(element.isTypeOnly) || isTypeOnly,
              });
            }
          }
        }
      }

      if (isTypeOnly) typeOnlyCount += 1;

      imports.push({
        specifier,
        nameBindings,
        isTypeOnly,
        span: span(node),
      });
      ts.forEachChild(node, visit);
      return;
    }

    // Re-exports: `export * from './y'`, `export { x } from './y'`
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        ts.forEachChild(node, visit);
        return;
      }
      const specifier = node.moduleSpecifier.text;
      const nameBindings = [];
      let kind = 'star';
      if (node.exportClause) {
        if (ts.isNamedExports(node.exportClause)) {
          kind = 'named';
          for (const element of node.exportClause.elements) {
            nameBindings.push({
              local: element.name.text,
              imported: element.propertyName ? element.propertyName.text : element.name.text,
            });
          }
        } else if (ts.isNamespaceExport(node.exportClause)) {
          // `export * as ns from './y'` -- still star-like for graph traversal.
          kind = 'star';
          nameBindings.push({ local: node.exportClause.name.text });
        }
      }
      reexports.push({
        specifier,
        kind,
        nameBindings,
        span: span(node),
      });
      ts.forEachChild(node, visit);
      return;
    }

    // Dynamic `import(...)` call expression.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      let argText = '';
      if (arg) {
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          argText = `'${arg.text}'`;
        } else {
          argText = arg.getText(sourceFile);
        }
      }
      dynamicImports.push({
        argText,
        span: span(node),
      });
      ts.forEachChild(node, visit);
      return;
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  return {
    imports,
    reexports,
    dynamicImports,
    typeOnlyCount,
    parseError,
  };
}

/**
 * Infer a TypeScript ScriptKind from a file path extension.
 *
 * @param {string} filePath
 * @returns {number} ts.ScriptKind value
 */
function inferScriptKind(filePath) {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.ts')) return ts.ScriptKind.TS;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/**
 * Parse source directly to an AST (exported for use by the call-scanner in as-004).
 *
 * @param {string} source
 * @param {string} filePath
 * @returns {ts.SourceFile}
 */
export function parseSourceToAst(source, filePath) {
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    inferScriptKind(filePath),
  );
}
