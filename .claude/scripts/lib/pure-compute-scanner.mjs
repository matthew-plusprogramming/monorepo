/**
 * Call / NewExpression Scanner for Pure-Compute Static Check
 *
 * Scans a file's AST for callsite-level blocklist matches:
 *   - `fs.writeFile`, `fs.writeFileSync`, `fs.appendFile`, `fs.appendFileSync`,
 *     `fs.rename`, `fs.unlink` (+ `fs.promises` equivalents)
 *   - `os.networkInterfaces()`
 *   - `process.exit()`
 *   - `eval(...)`
 *   - `Function(...)` and `new Function(...)`
 *   - Reflection-obtained constructors: `AsyncFunction`, `GeneratorFunction`,
 *     `Object.getPrototypeOf(async () => {}).constructor`,
 *     `Reflect.getPrototypeOf(function*(){}).constructor`
 *   - `setTimeout`/`setInterval` with string-literal (or static template literal) first arg
 *   - Top-level `fetch(...)` (module scope only; inside function bodies is allowed)
 *
 * Handles namespace-tracked MemberExpressions: `import * as ns from 'fs'` binds
 * `ns` to `fs`, so `ns.writeFile(...)` is matched as `fs.writeFile`.
 *
 * Emits one `{symbol, importSpecifier, nodeText, span}` record per match.
 *
 * Spec: sg-e2e-pure-compute-check atomic as-004 (Task T4; EC-PCC-8/-10/-11/-12/-13/-14/-15/-17)
 * Requirements: REQ-F-011 (callsite-level matches); SEC-014 (reflection patterns)
 */

import ts from 'typescript';

// =============================================================================
// Constants
// =============================================================================

/** fs write-side method names (checked as `fs.X(...)` or `fs.promises.X(...)`). */
const FS_WRITE_METHODS = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rename',
  'renameSync',
  'unlink',
  'unlinkSync',
]);

/** Blocklisted `os.X()` method names. */
const OS_BLOCKED_METHODS = new Set(['networkInterfaces']);

/** Blocklisted `process.X()` method names. */
const PROCESS_BLOCKED_METHODS = new Set(['exit']);

/** Global identifiers treated as blocklisted function calls. */
const GLOBAL_BLOCKED_IDENTIFIERS = new Set([
  'eval',
  'Function',
  'AsyncFunction',
  'GeneratorFunction',
]);

/** Timer identifiers that fail when first argument is a string literal. */
const STRING_TIMER_IDENTIFIERS = new Set(['setTimeout', 'setInterval']);

// =============================================================================
// Public API
// =============================================================================

/**
 * @typedef {Object} ImportRecord
 * @property {string} specifier
 * @property {Array<{kind: string, local: string, imported?: string, isTypeOnly?: boolean}>} nameBindings
 *
 * @typedef {Object} CallSiteRecord
 * @property {string} symbol - Canonical blocklist symbol (`fs.writeFile`, `eval`, ...)
 * @property {string} importSpecifier - Source module text or inline expression
 * @property {string} nodeText - Raw text of the call/new expression
 * @property {{line: number, column: number}} span
 */

/**
 * Scan a file's AST for callsite-level blocklist matches.
 *
 * @param {ts.SourceFile} sourceFile - Parsed source file (setParentNodes: true)
 * @param {ImportRecord[]} importRecords - From `extractImports` for this file
 * @returns {CallSiteRecord[]}
 */
export function scanCallSites(sourceFile, importRecords) {
  const callSites = [];

  // Build a map of namespace binding -> module specifier, for `import * as ns from 'fs'`.
  const nsBindingToSpecifier = new Map();
  // Build a map of default-import binding -> module specifier, for `import fs from 'fs'`.
  const defaultBindingToSpecifier = new Map();
  for (const record of importRecords || []) {
    if (record.isTypeOnly) continue;
    for (const b of record.nameBindings || []) {
      if (b.isTypeOnly) continue;
      if (b.kind === 'namespace') {
        nsBindingToSpecifier.set(b.local, record.specifier);
      } else if (b.kind === 'default') {
        defaultBindingToSpecifier.set(b.local, record.specifier);
      }
    }
  }

  function spanOf(node) {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: pos.line + 1, column: pos.character + 1 };
  }

  function nodeText(node) {
    try {
      return node.getText(sourceFile);
    } catch {
      return '';
    }
  }

  /** Emit a match, deduplicating by (line, column, symbol). */
  const seen = new Set();
  function emit(symbol, importSpecifier, node) {
    const s = spanOf(node);
    const key = `${s.line}:${s.column}:${symbol}`;
    if (seen.has(key)) return;
    seen.add(key);
    callSites.push({
      symbol,
      importSpecifier,
      nodeText: nodeText(node),
      span: s,
    });
  }

  /** Check if a node is at the top-level (module body, not inside a function). */
  function isTopLevel(node) {
    let cursor = node.parent;
    while (cursor) {
      if (
        ts.isFunctionDeclaration(cursor) ||
        ts.isFunctionExpression(cursor) ||
        ts.isArrowFunction(cursor) ||
        ts.isMethodDeclaration(cursor) ||
        ts.isGetAccessorDeclaration(cursor) ||
        ts.isSetAccessorDeclaration(cursor) ||
        ts.isConstructorDeclaration(cursor)
      ) {
        return false;
      }
      if (ts.isSourceFile(cursor)) return true;
      cursor = cursor.parent;
    }
    return true;
  }

  /**
   * Return the "last name" of a chained MemberExpression as an array of segments.
   * `fs.promises.writeFile` -> ['fs', 'promises', 'writeFile'].
   * Returns null if the expression isn't a pure dotted chain.
   */
  function unrollMemberChain(expr) {
    const segments = [];
    let cursor = expr;
    while (cursor) {
      if (ts.isPropertyAccessExpression(cursor)) {
        segments.unshift(cursor.name.text);
        cursor = cursor.expression;
      } else if (ts.isIdentifier(cursor)) {
        segments.unshift(cursor.text);
        return segments;
      } else {
        return null;
      }
    }
    return segments;
  }

  /**
   * Classify a MemberExpression call's root binding as an `fs`-aliased object.
   * Returns the canonical module specifier (`'fs'`) if the root is bound to
   * `fs`, otherwise null.
   */
  function fsRootSpecifier(rootBinding) {
    // Namespace import: `import * as ns from 'fs'` -> ns.writeFile
    const nsSpec = nsBindingToSpecifier.get(rootBinding);
    if (nsSpec === 'fs' || nsSpec === 'node:fs' || nsSpec === 'fs/promises' || nsSpec === 'node:fs/promises') {
      return nsSpec.startsWith('node:') ? nsSpec.slice('node:'.length) : nsSpec;
    }
    // Default import: `import fs from 'fs'` -> fs.writeFile
    const defSpec = defaultBindingToSpecifier.get(rootBinding);
    if (defSpec === 'fs' || defSpec === 'node:fs' || defSpec === 'fs/promises' || defSpec === 'node:fs/promises') {
      return defSpec.startsWith('node:') ? defSpec.slice('node:'.length) : defSpec;
    }
    return null;
  }

  /**
   * Return true if the root binding identifier is a direct reference to the
   * `os` module (via default or namespace import, bare or `node:` prefixed).
   */
  function osRootSpecifier(rootBinding) {
    const nsSpec = nsBindingToSpecifier.get(rootBinding);
    if (nsSpec === 'os' || nsSpec === 'node:os') return 'os';
    const defSpec = defaultBindingToSpecifier.get(rootBinding);
    if (defSpec === 'os' || defSpec === 'node:os') return 'os';
    return null;
  }

  function visit(node) {
    // CallExpression
    if (ts.isCallExpression(node)) {
      handleCallExpression(node);
    }
    // NewExpression (e.g., `new Function('...')`)
    if (ts.isNewExpression(node)) {
      handleNewExpression(node);
    }
    // Standalone `.constructor` access for reflection patterns:
    // `const AF = Object.getPrototypeOf(async () => {}).constructor;`
    // This is a PropertyAccessExpression, not a CallExpression. We check
    // here to avoid missing the match when the constructor reference is
    // stored without an immediate invocation.
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') {
      const protoKind = classifyPrototypeSource(node.expression);
      if (protoKind === 'async') {
        emit('AsyncFunction-via-reflection', nodeText(node), node);
      } else if (protoKind === 'generator') {
        emit('GeneratorFunction-via-reflection', nodeText(node), node);
      }
    }
    ts.forEachChild(node, visit);
  }

  function handleCallExpression(node) {
    const callee = node.expression;

    // Direct identifier call: eval(...), Function(...), fetch(...), setTimeout('code', 1)
    if (ts.isIdentifier(callee)) {
      const name = callee.text;

      if (GLOBAL_BLOCKED_IDENTIFIERS.has(name)) {
        if (name === 'AsyncFunction') {
          emit('AsyncFunction', name, node);
        } else if (name === 'GeneratorFunction') {
          emit('GeneratorFunction', name, node);
        } else {
          emit(name, name, node);
        }
        return;
      }

      if (name === 'fetch') {
        // Only module-scope fetch is blocklisted.
        if (isTopLevel(node)) {
          emit('fetch', 'fetch', node);
        }
        return;
      }

      if (STRING_TIMER_IDENTIFIERS.has(name)) {
        const firstArg = node.arguments[0];
        if (firstArg && isStringLikeLiteral(firstArg)) {
          emit(`${name}-string-arg`, name, node);
        }
        return;
      }
      return;
    }

    // MemberExpression or ElementAccess: fs.writeFile, os.networkInterfaces,
    // fs.promises.writeFile, Object.getPrototypeOf(...).constructor, etc.
    if (ts.isPropertyAccessExpression(callee)) {
      handleMemberCall(node, callee);
      return;
    }
  }

  function handleMemberCall(node, callee) {
    const segments = unrollMemberChain(callee);
    if (!segments || segments.length < 2) return;

    // Reflection pattern: X.constructor where X was obtained from
    // Object.getPrototypeOf / Reflect.getPrototypeOf. Handle this first so the
    // prototype-root isn't misclassified as an fs/os root.
    if (segments[segments.length - 1] === 'constructor') {
      const protoKind = classifyPrototypeSource(callee.expression);
      if (protoKind === 'async') {
        emit('AsyncFunction-via-reflection', nodeText(node), node);
        return;
      }
      if (protoKind === 'generator') {
        emit('GeneratorFunction-via-reflection', nodeText(node), node);
        return;
      }
    }

    const root = segments[0];
    const tail = segments[segments.length - 1];

    // fs.writeFile / fs.promises.writeFile / ns.writeFile via namespace tracking
    const fsRoot = fsRootSpecifier(root);
    if (fsRoot) {
      if (segments.length === 2 && FS_WRITE_METHODS.has(tail)) {
        emit(`fs.${canonicalFsMethod(tail)}`, fsRoot, node);
        return;
      }
      if (segments.length === 3 && segments[1] === 'promises' && FS_WRITE_METHODS.has(tail)) {
        emit(`fs.promises.${canonicalFsMethod(tail)}`, fsRoot, node);
        return;
      }
    }
    // Direct `fs.writeFile(...)` even without an import record (e.g. global
    // injection) -- fail-closed: match anyway so a missed import doesn't
    // silently exempt the call.
    if (root === 'fs') {
      if (segments.length === 2 && FS_WRITE_METHODS.has(tail)) {
        emit(`fs.${canonicalFsMethod(tail)}`, 'fs', node);
        return;
      }
      if (segments.length === 3 && segments[1] === 'promises' && FS_WRITE_METHODS.has(tail)) {
        emit(`fs.promises.${canonicalFsMethod(tail)}`, 'fs', node);
        return;
      }
    }

    // os.networkInterfaces() via namespace tracking OR bare `os`.
    const osRoot = osRootSpecifier(root) || (root === 'os' ? 'os' : null);
    if (osRoot && segments.length === 2 && OS_BLOCKED_METHODS.has(tail)) {
      emit(`os.${tail}`, osRoot, node);
      return;
    }

    // process.exit() -- `process` is the global; no import needed.
    if (root === 'process' && segments.length === 2 && PROCESS_BLOCKED_METHODS.has(tail)) {
      emit(`process.${tail}`, 'process', node);
      return;
    }

    // globalThis.eval(...), globalThis.Function(...) -- indirect eval paths.
    if (root === 'globalThis' && segments.length === 2 && GLOBAL_BLOCKED_IDENTIFIERS.has(tail)) {
      emit(tail, `globalThis.${tail}`, node);
      return;
    }
  }

  function handleNewExpression(node) {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && GLOBAL_BLOCKED_IDENTIFIERS.has(callee.text)) {
      emit(callee.text, callee.text, node);
    }
  }

  ts.forEachChild(sourceFile, visit);
  return callSites;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Return true if an expression is a string literal or a no-substitution
 * template literal (both safe for indirect-eval string detection).
 */
function isStringLikeLiteral(expr) {
  if (ts.isStringLiteral(expr)) return true;
  if (ts.isNoSubstitutionTemplateLiteral(expr)) return true;
  return false;
}

/**
 * Normalize fs method variants to their canonical name. Preserves `Sync`
 * suffixes since the blocklist distinguishes them.
 */
function canonicalFsMethod(name) {
  return name;
}

/**
 * Classify the source of a `.constructor` access to detect reflection-obtained
 * AsyncFunction/GeneratorFunction constructors.
 *
 * Patterns matched:
 *   Object.getPrototypeOf(async () => {}).constructor -> 'async'
 *   Object.getPrototypeOf(async function () {}).constructor -> 'async'
 *   Reflect.getPrototypeOf(function*(){}).constructor -> 'generator'
 *   Object.getPrototypeOf(function*(){}).constructor -> 'generator'
 *   Reflect.getPrototypeOf(async () => {}).constructor -> 'async'
 *
 * Returns 'async' | 'generator' | null.
 */
function classifyPrototypeSource(expr) {
  // Expression of `X.constructor` is the `X` prior to `.constructor`.
  // Typically: CallExpression for Object.getPrototypeOf(value) / Reflect.getPrototypeOf(value).
  if (!ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!(ts.isIdentifier(callee.expression))) return null;
  const root = callee.expression.text;
  const method = callee.name.text;
  if (!(root === 'Object' || root === 'Reflect')) return null;
  if (method !== 'getPrototypeOf') return null;

  const arg = expr.arguments[0];
  if (!arg) return null;

  // Async function literal?
  if (ts.isArrowFunction(arg) && arg.modifiers && arg.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    return 'async';
  }
  if (ts.isFunctionExpression(arg)) {
    if (arg.modifiers && arg.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      return 'async';
    }
    // Generator: `function*(){}`
    if (arg.asteriskToken) {
      return 'generator';
    }
  }

  return null;
}
