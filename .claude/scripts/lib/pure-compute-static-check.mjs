/**
 * Pure-Compute Static-Analysis Sub-Check
 *
 * Library API callable from completion-verifier Gate 5 (step 4 of the 9-step
 * pipeline) to validate a spec's `e2e_skip: true` + `rationale: pure-compute`
 * opt-out against the REQ-F-011 authoritative blocklist.
 *
 * The walker is a STATIC import-graph analyzer:
 *   - DFS traversal from spec-declared entry points
 *   - Resolves TypeScript `tsconfig.json#compilerOptions.paths` aliases
 *   - Follows re-exports (`export * from`, `export { x } from`)
 *   - Two-state visited-set (`in-progress` / `finalized`) for cycle detection
 *   - Equivalence-class folding: any disallowed import fails every cycle node
 *   - `node:` prefix normalization (`node:fs` === `fs`)
 *   - Explicit `perf_hooks` safelist
 *   - Fail-closed on resolution / parse errors (never silent-pass)
 *
 * Canonical Violation shape (public API surface, 4 fields only):
 *   { file, importSpecifier, symbol, pathToEntry }
 * The matcher-internal `category` field MUST be stripped by the walker before
 * aggregation into the final `Violation[]` returned by `checkPureCompute`.
 *
 * Security:
 *   - SEC-003: author-honesty gap -- closed by full blocklist enforcement.
 *   - SEC-009: transitive import graph completeness -- DFS + alias + re-exports.
 *   - SEC-014: reflection-obtained AsyncFunction/GeneratorFunction detection.
 *   - Fail-closed semantics: `verdict = 'fail'` iff `violations.length > 0`.
 *
 * Docs: .claude/docs/PURE-COMPUTE-CHECK.md
 * API: .claude/docs/PURE-COMPUTE-CHECK-API.md
 * Requirements: REQ-F-011, REQ-F-011a, REQ-NFR-020
 */

import { z } from 'zod';

// Re-export diagnostic formatters for consumer ergonomics (as-007).
export { formatViolation, formatViolations } from './pure-compute-formatter.mjs';

// =============================================================================
// Public Error Classes (AC1.4)
// =============================================================================

/**
 * Raised when a blocklisted symbol is detected. Structured error class with
 * machine-readable `code` for downstream error handling.
 *
 * Not thrown by `checkPureCompute` itself (which always returns a verdict);
 * reserved for library consumers who want to bubble violations as exceptions.
 *
 * Constructor accepts either:
 *   - (message: string, options?: {code?: string, ...context})
 *   - ({symbol, file, importSpecifier, pathToEntry}) -- legacy structured form
 *
 * Both forms produce an Error with a string `code` property (default
 * `'PURE_COMPUTE_BLOCKLIST_VIOLATION'`).
 */
export class PureComputeBlocklistViolation extends Error {
  constructor(...args) {
    const { message, context } = normalizeErrorArgs(args, (ctx) => {
      const entry = (ctx.pathToEntry && ctx.pathToEntry[0]) || ctx.file || '<unknown>';
      return `Blocklisted symbol '${ctx.symbol || '<unknown>'}' reachable from ${entry}`;
    });
    super(message);
    this.name = 'PureComputeBlocklistViolation';
    this.code = context.code || 'PURE_COMPUTE_BLOCKLIST_VIOLATION';
    this.blame = 'client';
    this.retry_safe = false;
    if (context.symbol) this.symbol = context.symbol;
    if (context.file) this.file = context.file;
    if (context.importSpecifier) this.importSpecifier = context.importSpecifier;
    if (context.pathToEntry) this.pathToEntry = context.pathToEntry;
  }
}

/**
 * Raised when an import specifier cannot be resolved to a file on disk or to
 * a `tsconfig.paths` candidate. Used internally and optionally surfaced by
 * consumers.
 *
 * Constructor forms match `PureComputeBlocklistViolation` (see above).
 */
export class PureComputeResolutionError extends Error {
  constructor(...args) {
    const { message, context } = normalizeErrorArgs(args, (ctx) => {
      const spec = ctx.specifier || '<unknown>';
      const src = ctx.fromFile || '<unknown>';
      return `Cannot resolve '${spec}' from ${src}: ${ctx.reason || 'not found'}`;
    });
    super(message);
    this.name = 'PureComputeResolutionError';
    this.code = context.code || 'PURE_COMPUTE_RESOLUTION_ERROR';
    this.blame = 'self';
    this.retry_safe = false;
    if (context.specifier) this.specifier = context.specifier;
    if (context.fromFile) this.fromFile = context.fromFile;
    if (context.reason) this.reason = context.reason;
  }
}

/**
 * Normalize dual-form constructor args:
 *   - (message: string, options?: {code?, ...})  -> {message, context: options ?? {}}
 *   - ({...structured})                          -> {message: defaultFn(struct), context: struct}
 */
function normalizeErrorArgs(args, defaultMessageFn) {
  if (args.length === 0) return { message: '', context: {} };
  const [first, second] = args;
  if (typeof first === 'string') {
    return { message: first, context: second && typeof second === 'object' ? second : {} };
  }
  if (first && typeof first === 'object') {
    const message = defaultMessageFn(first);
    return { message, context: first };
  }
  return { message: String(first), context: {} };
}

// =============================================================================
// Zod Input Schema (AC1.2)
// =============================================================================

/**
 * Input schema for `checkPureCompute`. Validated at function entry.
 *
 * Note: `tsconfigPath` omission and explicit `undefined` are semantically
 * equivalent per contract (`spec.md:218`). Both trigger graceful-degradation:
 * relative + absolute + node_modules resolution only, no alias expansion.
 */
export const CheckPureComputeInputSchema = z.object({
  specId: z.string().min(1, 'specId is required'),
  entryPoints: z
    .array(z.string().min(1, 'entryPoint paths must be non-empty strings'))
    .min(1, 'entryPoints must contain at least one file path'),
  tsconfigPath: z.string().optional(),
});

// =============================================================================
// Public API: checkPureCompute (AC1.1, AC1.3)
// =============================================================================

/**
 * Run the pure-compute static-analysis sub-check.
 *
 * Invoked from completion-verifier Gate 5 step 4 after enforcement-mode
 * resolution, crosses_boundary scope determination, and e2e_skip_rationale
 * enum validation (per D-035 co-location).
 *
 * Determinism: pure function of (input file contents, tsconfig, entry points).
 * No network, no subprocess, no wall-clock dependency.
 *
 * Fail-closed semantics:
 *   - verdict === 'fail' iff violations.length > 0
 *   - Unresolvable imports -> violation with symbol='<resolution-failed>'
 *   - Parse errors         -> violation with symbol='<parse-error>'
 *   - Never throws on analysis errors; always returns structured verdict.
 *
 * @param {object} params
 * @param {string} params.specId - Spec group id (must match [a-z0-9-]+)
 * @param {string[]} params.entryPoints - Absolute-or-spec-relative file paths
 * @param {string|undefined} [params.tsconfigPath] - Optional tsconfig.json path
 * @returns {Promise<{verdict: 'pass'|'fail', violations: Array<{file: string, importSpecifier: string, symbol: string, pathToEntry: string[]}>}>}
 */
export async function checkPureCompute(params) {
  // Zod validation at the boundary (AC1.2). Throws on invalid input.
  const input = CheckPureComputeInputSchema.parse(params);

  // Delegate to the walker; walker owns canonical-shape aggregation (AC6.15).
  // Lazy import keeps module-scope free of filesystem side effects (AC1.5).
  const { walkGraph } = await import('./pure-compute-walker.mjs');
  const result = await walkGraph({
    entryPoints: input.entryPoints,
    tsconfigPath: input.tsconfigPath,
  });

  // Fail-closed verdict derivation (contract: `verdict='fail' iff violations.length > 0`).
  const verdict = result.violations.length > 0 ? 'fail' : 'pass';

  return {
    verdict,
    violations: result.violations,
  };
}
