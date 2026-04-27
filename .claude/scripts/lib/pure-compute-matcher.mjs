/**
 * Blocklist Match Engine for Pure-Compute Static Check
 *
 * Combines module-level specifier lookups with callsite records (from
 * `pure-compute-scanner.mjs`) and dynamic-import records (from
 * `pure-compute-extractor.mjs`) into a single violation stream.
 *
 * Authoritative categories (verbatim from `spec.md` § Interfaces & Contracts
 * `Blocklist` yaml):
 *   - network: ['net', 'http', 'https', 'dns', 'dgram', 'tls', 'http2']
 *   - fs_write: ['fs.writeFile', 'fs.writeFileSync', 'fs.appendFile',
 *                'fs.appendFileSync', 'fs.rename', 'fs.unlink'] + fs.promises variants
 *   - process: ['child_process', 'worker_threads', 'cluster', 'process.exit']
 *   - diagnostics: ['diagnostics_channel', 'inspector', 'trace_events']
 *   - interactive: ['readline', 'repl']
 *   - code_exec: ['vm'] + eval / Function (callsite) + AsyncFunction/GeneratorFunction
 *   - indirect_eval: ['<setTimeout-string-arg>', '<setInterval-string-arg>']
 *   - dynamic_import: ['<dynamic-import>']
 *   - top_level_fetch: ['fetch']
 *   - os_functions: ['os.networkInterfaces']
 *
 * Safelist (explicit, one entry): `perf_hooks` / `node:perf_hooks`.
 *
 * Fail-closed semantics (AC5.10, AC5.11, AC5.12 -- security-tagged):
 *   - Unresolvable import -> symbol: '<resolution-failed>'
 *   - Parse error         -> symbol: '<parse-error>'
 *   - Silent warn-and-continue is EXPLICITLY REJECTED
 *
 * Internal-only field scope (AC5.1):
 *   - The intermediate matcher output includes `category` to aid diagnostics.
 *   - The walker (as-006) MUST strip `category` before aggregation (AC6.15).
 *
 * Spec: sg-e2e-pure-compute-check atomic as-005 (Task T5 + T16; EC-PCC-4, EC-PCC-5)
 * Requirements: REQ-F-011, REQ-NFR-020
 */

// =============================================================================
// Authoritative Blocklist (verbatim from `spec.md` Interfaces & Contracts)
// =============================================================================

/**
 * Module-level blocklist. Key is the normalized specifier (no `node:` prefix);
 * value is the category label.
 *
 * Normalization: `node:fs` === `fs`; performed by `normalizeSpecifier`.
 */
export const MODULE_BLOCKLIST = Object.freeze({
  // network
  'net': 'network',
  'http': 'network',
  'https': 'network',
  'dns': 'network',
  'dgram': 'network',
  'tls': 'network',
  'http2': 'network',
  // fs-write sub-paths (module level imports of fs/promises)
  'fs/promises': 'fs_write',
  // process / subprocess
  'child_process': 'process',
  'worker_threads': 'process',
  'cluster': 'process',
  // diagnostics
  'diagnostics_channel': 'diagnostics',
  'inspector': 'diagnostics',
  'trace_events': 'diagnostics',
  // interactive
  'readline': 'interactive',
  'repl': 'interactive',
  // code-exec
  'vm': 'code_exec',
});

/** Explicit safelist; exactly one entry. */
export const SAFELIST = Object.freeze(new Set(['perf_hooks']));

/**
 * Callsite-level symbol -> category mapping. Consumed when normalizing
 * intermediate callsite records into violations.
 */
const CALLSITE_CATEGORY = Object.freeze({
  // fs write
  'fs.writeFile': 'fs_write',
  'fs.writeFileSync': 'fs_write',
  'fs.appendFile': 'fs_write',
  'fs.appendFileSync': 'fs_write',
  'fs.rename': 'fs_write',
  'fs.renameSync': 'fs_write',
  'fs.unlink': 'fs_write',
  'fs.unlinkSync': 'fs_write',
  'fs.promises.writeFile': 'fs_write',
  'fs.promises.writeFileSync': 'fs_write',
  'fs.promises.appendFile': 'fs_write',
  'fs.promises.appendFileSync': 'fs_write',
  'fs.promises.rename': 'fs_write',
  'fs.promises.renameSync': 'fs_write',
  'fs.promises.unlink': 'fs_write',
  'fs.promises.unlinkSync': 'fs_write',
  // process
  'process.exit': 'process',
  // code-exec
  'eval': 'code_exec',
  'Function': 'code_exec',
  'AsyncFunction': 'code_exec',
  'GeneratorFunction': 'code_exec',
  'AsyncFunction-via-reflection': 'code_exec',
  'GeneratorFunction-via-reflection': 'code_exec',
  // indirect-eval
  'setTimeout-string-arg': 'indirect_eval',
  'setInterval-string-arg': 'indirect_eval',
  // top-level fetch
  'fetch': 'top_level_fetch',
  // os functions
  'os.networkInterfaces': 'os_functions',
});

// =============================================================================
// Public API
// =============================================================================

/**
 * @typedef {Object} MatcherViolation
 * @property {string} symbol - Canonical blocklist symbol
 * @property {string} importSpecifier - Raw import specifier or expression text
 * @property {string} category - INTERNAL-ONLY; walker strips before aggregation (AC5.1 / AC6.15)
 * @property {{line: number, column: number}} [span]
 * @property {string} [file]
 */

/**
 * Normalize a module specifier for blocklist lookup.
 *
 * `node:` prefix is stripped (EC-PCC-4). Returns the normalized string.
 *
 * @param {string} specifier
 * @returns {string}
 */
export function normalizeSpecifier(specifier) {
  if (typeof specifier !== 'string') return '';
  if (specifier.startsWith('node:')) return specifier.slice('node:'.length);
  return specifier;
}

/**
 * Return true if the specifier (normalized) is on the explicit safelist.
 *
 * Both `perf_hooks` and `node:perf_hooks` pass.
 *
 * @param {string} specifier
 * @returns {boolean}
 */
export function isSafeList(specifier) {
  return SAFELIST.has(normalizeSpecifier(specifier));
}

/**
 * Match a specifier + callsite + dynamic-import bundle against the blocklist.
 *
 * @param {Object} params
 * @param {string} [params.specifier] - Module specifier (for module-level match)
 * @param {Array<{symbol: string, importSpecifier: string, nodeText?: string, span?: any}>} [params.callSites] - From scanner
 * @param {Array<{argText: string, span: any}>} [params.dynamicImports] - From extractor
 * @param {string} [params.file] - Source file being matched (forwarded onto violations)
 * @returns {MatcherViolation[]}
 */
export function matchBlocklist(params) {
  const violations = [];
  const { specifier, callSites = [], dynamicImports = [], file } = params || {};

  // ---------------------------------------------------------------------------
  // Module-level specifier match
  // ---------------------------------------------------------------------------
  if (typeof specifier === 'string' && specifier.length > 0) {
    // Safelist wins over blocklist (AC5.8: safelist applies regardless of callsites).
    if (!isSafeList(specifier)) {
      const normalized = normalizeSpecifier(specifier);
      if (Object.prototype.hasOwnProperty.call(MODULE_BLOCKLIST, normalized)) {
        const category = MODULE_BLOCKLIST[normalized];
        violations.push({
          symbol: normalized,
          importSpecifier: specifier,
          category,
          file,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Callsite records (fs.writeFile, fetch, eval, ...)
  // ---------------------------------------------------------------------------
  for (const cs of callSites) {
    if (!cs || typeof cs.symbol !== 'string') continue;
    const category = CALLSITE_CATEGORY[cs.symbol] || 'callsite';
    violations.push({
      symbol: cs.symbol,
      importSpecifier: cs.importSpecifier || '',
      category,
      span: cs.span,
      file,
    });
  }

  // ---------------------------------------------------------------------------
  // Dynamic-import records (unconditional fail)
  // ---------------------------------------------------------------------------
  for (const di of dynamicImports) {
    if (!di) continue;
    violations.push({
      symbol: '<dynamic-import>',
      importSpecifier: di.argText || '<dynamic>',
      category: 'dynamic_import',
      span: di.span,
      file,
    });
  }

  return violations;
}

/**
 * Construct a `<resolution-failed>` violation (AC5.10).
 *
 * Emitted by the walker when the resolver returns null. Fail-closed: the
 * violation is recorded and `verdict` becomes `'fail'`.
 *
 * @param {Object} params
 * @param {string} params.file - The importing source file
 * @param {string} params.importSpecifier - The unresolved specifier text
 * @returns {MatcherViolation}
 */
export function makeResolutionFailedViolation({ file, importSpecifier }) {
  return {
    symbol: '<resolution-failed>',
    importSpecifier,
    category: 'resolution_failed',
    file,
  };
}

/**
 * Construct a `<parse-error>` violation (AC5.11).
 *
 * Emitted by the walker when extractor reports a parse error. Fail-closed.
 *
 * @param {Object} params
 * @param {string} params.file - The unparseable source file
 * @returns {MatcherViolation}
 */
export function makeParseErrorViolation({ file }) {
  return {
    symbol: '<parse-error>',
    importSpecifier: file,
    category: 'parse_error',
    file,
  };
}
