---
_source_spec: sg-e2e-pure-compute-check
_source_modules:
  [
    'scripts-lib/pure-compute-static-check',
    'scripts-lib/pure-compute-walker',
    'scripts-lib/pure-compute-resolver',
    'scripts-lib/pure-compute-extractor',
    'scripts-lib/pure-compute-scanner',
    'scripts-lib/pure-compute-matcher',
    'scripts-lib/pure-compute-formatter',
    'scripts-lib/path-containment',
  ]
title: Pure-Compute Static-Analysis Sub-Check — API Reference
last_reviewed: 2026-04-21
---

# Pure-Compute Static-Analysis Sub-Check — API Reference

API reference for `.claude/scripts/lib/pure-compute-*.mjs` and the shared `path-containment.mjs` utility. All modules are ES-module JavaScript (`.mjs`) with JSDoc type hints.

Public entry point: [`pure-compute-static-check.mjs`](../scripts/lib/pure-compute-static-check.mjs). Internal modules may be imported directly by tests and orchestration code; they are not considered stable third-party surface.

For the higher-level overview (purpose, Gate 5 integration, sentinel semantics), see [PURE-COMPUTE-CHECK.md](PURE-COMPUTE-CHECK.md). For the authoritative blocklist, see [PURE-COMPUTE-CHECK-BLOCKLIST.md](PURE-COMPUTE-CHECK-BLOCKLIST.md).

## Table of Contents

- [Entry Point — `pure-compute-static-check.mjs`](#entry-point--pure-compute-static-checkmjs)
- [Resolver — `pure-compute-resolver.mjs`](#resolver--pure-compute-resolvermjs)
- [Extractor — `pure-compute-extractor.mjs`](#extractor--pure-compute-extractormjs)
- [Scanner — `pure-compute-scanner.mjs`](#scanner--pure-compute-scannermjs)
- [Matcher — `pure-compute-matcher.mjs`](#matcher--pure-compute-matchermjs)
- [Walker — `pure-compute-walker.mjs`](#walker--pure-compute-walkermjs)
- [Diagnostic Formatter — `pure-compute-formatter.mjs`](#diagnostic-formatter--pure-compute-formattermjs)
- [Path Containment — `path-containment.mjs`](#path-containment--path-containmentmjs)
- [Canonical `Violation` Shape](#canonical-violation-shape)
- [Error Classes](#error-classes)

## Entry Point — `pure-compute-static-check.mjs`

### `checkPureCompute(params)`

Run the pure-compute static-analysis sub-check. Invoked from completion-verifier Gate 5 step 4. Pure function of inputs; no network, no subprocess, no wall-clock dependency.

**Signature**:

```javascript
async function checkPureCompute(params: {
  specId: string,
  entryPoints: string[],
  tsconfigPath?: string,
}): Promise<{
  verdict: 'pass' | 'fail',
  violations: Array<{
    file: string,
    importSpecifier: string,
    symbol: string,
    pathToEntry: string[],
  }>,
}>;
```

**Parameters**:

| Field          | Type       | Required | Description                                                                                                                  |
| -------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `specId`       | `string`   | Yes      | Spec group id; must match `/^[a-z0-9-]+$/`. Forwarded for logging.                                                           |
| `entryPoints`  | `string[]` | Yes      | One or more absolute-or-cwd-relative file paths from which to start DFS. Must contain at least one non-empty string.         |
| `tsconfigPath` | `string`   | No       | Optional tsconfig.json path for alias resolution. Omission and explicit `undefined` are semantically equivalent (see below). |

**Return**:

| Field        | Type             | Description                                                                               |
| ------------ | ---------------- | ----------------------------------------------------------------------------------------- |
| `verdict`    | `'pass'\|'fail'` | `'fail'` iff `violations.length > 0`. Always one of these two values.                     |
| `violations` | `Violation[]`    | Canonical 4-field records. See [Canonical `Violation` Shape](#canonical-violation-shape). |

**Graceful degradation for `tsconfigPath`**:

When `tsconfigPath` is omitted, `undefined`, or points to a missing / malformed file, the walker operates with relative + absolute + node_modules resolution only (no alias expansion). Imports that depend on tsconfig aliases emit `<resolution-failed>` sentinels.

**Fail-closed semantics**:

- Unresolvable imports → `<resolution-failed>` sentinel
- Parse errors → `<parse-error>` sentinel
- Entry-point containment escapes (SEC-TRAVERSAL-001) → `<resolution-failed>` sentinel
- Never throws on analysis errors; always returns a structured verdict

**Throws**:

| Error      | Cause                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------ |
| `ZodError` | Input validation failure (missing `specId`, empty `entryPoints`, non-string values, etc.). |

**Example**:

```javascript
import { checkPureCompute } from '.claude/scripts/lib/pure-compute-static-check.mjs';

const result = await checkPureCompute({
  specId: 'sg-my-feature',
  entryPoints: ['./src/my-feature/index.ts'],
  tsconfigPath: './tsconfig.json',
});

if (result.verdict === 'fail') {
  for (const v of result.violations) {
    console.error(
      `${v.file} imports '${v.importSpecifier}' (${v.symbol}) via ${v.pathToEntry.join(' -> ')}`,
    );
  }
}
```

### `CheckPureComputeInputSchema`

Zod schema used for input validation at the API boundary. Exported for callers that want to validate inputs themselves before invocation.

```javascript
import { CheckPureComputeInputSchema } from '.claude/scripts/lib/pure-compute-static-check.mjs';

const parsed = CheckPureComputeInputSchema.parse(params);
```

### Re-exports

The entry module re-exports `formatViolation` and `formatViolations` from the formatter for consumer ergonomics.

## Resolver — `pure-compute-resolver.mjs`

TypeScript path-alias resolver with path-containment gate (SEC-TRAVERSAL-001).

### `loadTsconfig(tsconfigPath, options)`

Load and parse a tsconfig.json, returning a normalized model. Graceful degradation: missing / malformed / undefined paths return an empty model without throwing.

**Signature**:

```javascript
function loadTsconfig(
  tsconfigPath: string | undefined,
  options?: { warn?: (message: string) => void },
): {
  paths: Record<string, string[]>,
  baseUrl: string | null,
  path: string | null,
};
```

**Return fields**:

| Field     | Type                       | Description                                                                                      |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `paths`   | `Record<string, string[]>` | Literal `compilerOptions.paths` map, e.g. `{ '@app/*': ['./src/app/*'] }`.                       |
| `baseUrl` | `string \| null`           | Absolute directory that `paths` are resolved against (tsconfig dir + `compilerOptions.baseUrl`). |
| `path`    | `string \| null`           | The tsconfig path that was loaded, or `null` when no tsconfig was found.                         |

**Behavior**:

- `tsconfigPath` undefined → empty model, no warning emitted (graceful default)
- File missing → empty model, single warning via `options.warn` if provided
- Malformed JSON → empty model, single warning via `options.warn` if provided
- Supports `//` line and `/* */` block comments (strips them conservatively)

### `resolveSpecifier(specifier, fromFile, tsconfig)`

Resolve an import specifier to an absolute file path, or `null` if no candidate exists on disk or the candidate escapes the containment root.

**Signature**:

```javascript
function resolveSpecifier(
  specifier: string,
  fromFile: string,
  tsconfig: {
    paths: Record<string, string[]>,
    baseUrl: string | null,
    projectRoot?: string | null,
  },
): string | null;
```

**Resolution order** (AC2.6):

1. Relative specifier (`./`, `../`) → resolve against `fromFile` directory
2. Absolute specifier → try as-is against `RESOLVER_EXTENSIONS`
3. tsconfig paths alias match → try each mapping in declaration order (exact key before wildcards; longer prefixes more specific)
4. No candidate → `null`

**`RESOLVER_EXTENSIONS`**: `['.mjs', '.ts', '.tsx', '.js', '.jsx', '.json']` — TypeScript source tried before built JS so fixture-heavy suites favor the source file when both exist. `index.*` is tried when a specifier resolves to a directory.

**Path containment** (SEC-TRAVERSAL-001):

When `tsconfig.projectRoot` is populated by the walker, every candidate passes through `assertContainment` (realpath + strict-prefix check). Paths that escape the root return `null`, which flows through the existing fail-closed path — the walker emits a `<resolution-failed>` sentinel. The resolver never re-throws `PathEscapeError` and never leaks the canonicalized path (which could expose filesystem layout).

When `projectRoot` is `null` (no containment root available), the gate is a no-op.

**Return**: Absolute resolved path (contained inside `projectRoot` when populated) or `null`.

### Node builtins

Bare `node:*` specifiers and bare node_modules packages are **not** resolved here — the caller classifies them via the blocklist matcher.

## Extractor — `pure-compute-extractor.mjs`

TypeScript AST parser that extracts the outgoing edges of a source file.

### `extractImports(filePath)`

Read and parse a file, returning `ExtractorResult`. Read failures return a structured `parseError` record instead of throwing.

**Signature**:

```javascript
function extractImports(filePath: string): ExtractorResult;
```

### `extractFromSource(source, filePath)`

Same as `extractImports` but takes source text directly; used for in-memory tests.

**Signature**:

```javascript
function extractFromSource(source: string, filePath: string): ExtractorResult;
```

### `parseSourceToAst(source, filePath)`

Parse source to a `ts.SourceFile`. Exported for the scanner (as-004) so it can reuse the parsed AST without re-parsing.

**`ExtractorResult`**:

| Field            | Type                                             | Description                                                               |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| `imports`        | `ImportRecord[]`                                 | Static `import` declarations with name bindings and `isTypeOnly` flag.    |
| `reexports`      | `ReexportRecord[]`                               | `export * from` and `export { x } from` declarations.                     |
| `dynamicImports` | `DynamicImportRecord[]`                          | `import(...)` call expressions (argument text preserved for diagnostics). |
| `typeOnlyCount`  | `number`                                         | Number of whole-declaration `import type` records (for audit).            |
| `parseError`     | `{kind: 'parse-error', message: string} \| null` | First syntactic diagnostic or file-read error.                            |

**Type-only filtering** (EC-PCC-7):

`import type { X } from 'y'` is flagged via `isTypeOnly: true` on the `ImportRecord`. Per-specifier type imports (`import { type X, Y }`) set `isTypeOnly` on the individual `nameBindings[]` entry. The walker filters type-only imports from frontier population.

**Dynamic-import capture** (EC-PCC-9):

Every `import(...)` call expression is recorded with its argument text. The matcher emits `<dynamic-import>` sentinels unconditionally — the resolver does not attempt to resolve the string argument.

## Scanner — `pure-compute-scanner.mjs`

Callsite scanner for AST-level matches that cannot be detected by module-specifier matching alone.

### `scanCallSites(sourceFile, importRecords)`

**Signature**:

```javascript
function scanCallSites(
  sourceFile: ts.SourceFile,
  importRecords: ImportRecord[],
): Array<{
  symbol: string,
  importSpecifier: string,
  nodeText: string,
  span: { line: number, column: number },
}>;
```

**Scans for**:

| Pattern                                                                               | Emitted `symbol`                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `fs.writeFile(...)`, `fs.writeFileSync`, `fs.appendFile*`, `fs.rename*`, `fs.unlink*` | `fs.<method>`                                      |
| `fs.promises.writeFile(...)`, etc.                                                    | `fs.promises.<method>`                             |
| `os.networkInterfaces()`                                                              | `os.networkInterfaces`                             |
| `process.exit()`                                                                      | `process.exit`                                     |
| `eval(...)`                                                                           | `eval`                                             |
| `Function(...)` or `new Function(...)`                                                | `Function`                                         |
| `AsyncFunction(...)` or `new AsyncFunction(...)`                                      | `AsyncFunction`                                    |
| `GeneratorFunction(...)` or `new GeneratorFunction(...)`                              | `GeneratorFunction`                                |
| `Object.getPrototypeOf(async () => {}).constructor`                                   | `AsyncFunction-via-reflection`                     |
| `Reflect.getPrototypeOf(function*(){}).constructor`                                   | `GeneratorFunction-via-reflection`                 |
| `setTimeout("code", ...)` or `setInterval` with string-literal first arg              | `setTimeout-string-arg` / `setInterval-string-arg` |
| `fetch(...)` at module top level only                                                 | `fetch`                                            |
| `globalThis.eval(...)`, `globalThis.Function(...)`                                    | `eval` / `Function`                                |

**Namespace binding tracking**:

`import * as ns from 'fs'` binds `ns` to `fs`, so `ns.writeFile(...)` is matched as `fs.writeFile`. The scanner builds a namespace-binding map and a default-import-binding map from the supplied `importRecords` to detect these paths. This covers both `node:fs` and `fs` source specifiers (and `fs/promises` variants).

**Top-level-only `fetch`**:

`fetch` is only flagged when the call expression is at module scope. Calls inside function bodies, arrow functions, methods, accessors, or constructors are intentionally not flagged — the top-level scope is where silent network calls would occur via the Node 18+ global.

**Deduplication**:

Matches are deduplicated by `(line, column, symbol)` so the same CallExpression is reported exactly once even when multiple scanner paths could match it.

## Matcher — `pure-compute-matcher.mjs`

Blocklist match engine. Combines module-level specifier lookups with callsite records (from scanner) and dynamic-import records (from extractor) into a single violation stream.

### `matchBlocklist(params)`

**Signature**:

```javascript
function matchBlocklist(params: {
  specifier?: string,
  callSites?: Array<{ symbol: string, importSpecifier: string, span?: any, nodeText?: string }>,
  dynamicImports?: Array<{ argText: string, span: any }>,
  file?: string,
}): MatcherViolation[];
```

**`MatcherViolation` shape** (intermediate):

| Field             | Type              | Public? | Description                                                       |
| ----------------- | ----------------- | ------- | ----------------------------------------------------------------- |
| `symbol`          | `string`          | Yes     | Canonical blocklist symbol or sentinel.                           |
| `importSpecifier` | `string`          | Yes     | Raw import specifier text or expression text.                     |
| `category`        | `string`          | **No**  | Matcher-internal category label. **Stripped by walker** (AC6.15). |
| `span`            | `{line, column}?` | No      | AST span when available.                                          |
| `file`            | `string?`         | Yes     | Source file being matched.                                        |

The `category` field is matcher-internal and must never appear on the canonical 4-field `Violation`; `symbol` is the public diagnostic handle.

### `normalizeSpecifier(specifier)`

Strip the `node:` prefix for blocklist lookup. `node:fs` → `fs`. `perf_hooks` → `perf_hooks`. Non-string input returns `''`.

### `isSafeList(specifier)`

Return `true` iff the normalized specifier is on the explicit safelist. The safelist contains exactly one entry: `perf_hooks`. Both `perf_hooks` and `node:perf_hooks` forms return `true`. Safelist matches short-circuit blocklist lookup.

### `makeResolutionFailedViolation({file, importSpecifier})`

Construct a `<resolution-failed>` sentinel violation. Emitted by the walker when the resolver returns `null` (missing file, unresolvable alias, or path-containment escape).

### `makeParseErrorViolation({file})`

Construct a `<parse-error>` sentinel violation. Emitted by the walker when the extractor reports a parse error or the file cannot be read. The `importSpecifier` field is set to `file` for diagnostic continuity.

### Exported constants

| Export             | Type                               | Purpose                                                        |
| ------------------ | ---------------------------------- | -------------------------------------------------------------- |
| `MODULE_BLOCKLIST` | `Readonly<Record<string, string>>` | Module-level blocklist: normalized specifier → category label. |
| `SAFELIST`         | `ReadonlySet<string>`              | Explicit safelist: `Set(['perf_hooks'])`.                      |

See [PURE-COMPUTE-CHECK-BLOCKLIST.md](PURE-COMPUTE-CHECK-BLOCKLIST.md) for the full list of entries.

## Walker — `pure-compute-walker.mjs`

DFS walker with two-state visited set and canonical-shape aggregation.

### `walkGraph(params)`

**Signature**:

```javascript
async function walkGraph(params: {
  entryPoints: string[],
  tsconfigPath?: string,
}): Promise<{
  visited: Map<string, 'in-progress' | 'finalized'>,
  violations: Violation[],
  cycles: Array<Set<string>>,
}>;
```

**`Violation`**: The canonical 4-field public shape. See [Canonical `Violation` Shape](#canonical-violation-shape).

**Traversal order** (AC6.11):

- DFS from each entry point in array order
- Sibling edges are sorted alphabetically by specifier before recursion
- Type-only imports are filtered from frontier population (AC6.10)

**Cycle detection** (AC6.3, AC6.4, AC6.5):

The walker maintains `Map<filePath, 'in-progress' | 'finalized'>`. On re-entering an `in-progress` node, the walker folds every pathStack member from the first occurrence onwards into an equivalence class. After traversal, overlapping cycle sets are merged via fix-point union-find (`mergeEquivalenceClasses`). If any cycle member has a violation, `propagateCycleViolations` duplicates the violation to every other cycle member — satisfying AC6.5 ("both A and B must appear among violation files").

**Cycle-propagation exclusions**: `<resolution-failed>` and `<parse-error>` sentinels are _not_ propagated across cycles. These are file-specific and propagating them would mislead authors into thinking the error is in a cycle partner when it originates in one specific file.

**Path-containment enforcement** (SEC-TRAVERSAL-001):

The walker derives the containment `projectRoot` before traversal:

1. `tsconfig.baseUrl` when tsconfig was loaded (explicit boundary)
2. Longest common ancestor of entry-point directories (derived boundary)
3. `dirname(firstEntry)` as single-entry fallback

The root is canonicalized via `realpathSync` to align with candidate realpaths (on macOS, `/tmp` resolves to `/private/tmp`; without canonicalization, every candidate would appear out-of-root). The resolver reads `tsconfig.projectRoot` and gates every candidate.

**Entry-point containment gate**: Entry points are checked against the containment root only when `tsconfig.baseUrl` is set (the independent boundary). When the root was derived from the entry points themselves, the first entry trivially passes its own containment check, so the gate adds no safety — enforcing it only for tsconfig-declared roots catches the case where a malicious spec author declares both a tsconfig _and_ an out-of-tree entry point.

**Canonical-shape aggregation** (AC6.15):

Before returning, the walker strips the matcher-internal `category` field from every intermediate violation, producing the canonical 4-field `Violation[]`. A single aggregation step: `{file, importSpecifier, symbol, pathToEntry: [...v.pathToEntry]}`.

**Fail-closed** (AC6.12, AC6.13, AC6.14):

- Resolver returns null → `<resolution-failed>` sentinel
- Extractor reports parse error → `<parse-error>` sentinel (walker still scans partial AST for edges)
- Walker continues exploring remaining frontier nodes
- `verdict='fail'` iff `violations.length > 0`
- Silent warn-and-continue is explicitly rejected

## Diagnostic Formatter — `pure-compute-formatter.mjs`

Human-readable renderer for `Violation` records. Does not mutate input (AC7.5). No ANSI escapes (AC7.6).

### `formatViolation(violation)`

Format a single violation as plain-text.

**Signature**:

```javascript
function formatViolation(violation: Violation & { span?: { line?: number, column?: number } }): string;
```

**Output format** (default):

```
<file>:<line> imports '<specifier>' (category: <symbol>). Reachable from entry point <entry> via path: <pathToEntry>.
```

**Special-symbol phrasing**:

| Symbol                | Rendered phrase                          |
| --------------------- | ---------------------------------------- |
| `<dynamic-import>`    | `uses dynamic import(<arg>)`             |
| `<resolution-failed>` | `could not resolve import '<specifier>'` |
| `<parse-error>`       | `parse error in <file>`                  |

When `violation.span.line` is not available, the `:<line>` suffix is omitted from `fileLoc`.

### `formatViolations(violations)`

Format an array joined by newlines. Empty / non-array input returns `''`.

## Path Containment — `path-containment.mjs`

Shared utility used by the pure-compute resolver and walker to enforce path-containment per SEC-TRAVERSAL-001.

### `assertContainment(target, claudeRoot)`

Resolve `target` via `realpathSync` (follows symlinks, canonicalizes `..`) and verify the result lies strictly within `claudeRoot`.

**Signature**:

```javascript
function assertContainment(target: string, claudeRoot: string): string;
```

**Containment rule**:

```
resolved === claudeRoot  OR  resolved.startsWith(claudeRoot + path.sep)
```

The trailing-separator check defeats prefix collisions: `/foo/.claude-evil/x.mjs` starts with `/foo/.claude` but not `/foo/.claude/`.

**Throws**:

| Error                   | Cause                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PathEscapeError`       | Resolved path escapes `claudeRoot`.                                                                                     |
| `Error` (ENOENT/EACCES) | `realpathSync` fails for other reasons. The pure-compute callers catch these and treat as unresolvable (return `null`). |

### `PathEscapeError`

Structured error for escape attempts.

| Field        | Type     | Description                              |
| ------------ | -------- | ---------------------------------------- |
| `name`       | `string` | `'PathEscapeError'`.                     |
| `code`       | `string` | `'PATH_ESCAPE'`.                         |
| `rule`       | `string` | `'path-escape'`.                         |
| `target`     | `string` | The input path.                          |
| `resolved`   | `string` | The canonicalized realpath.              |
| `claudeRoot` | `string` | The root used for the containment check. |

The pure-compute modules **swallow** `PathEscapeError` inside `containOrNull` / `safeContain` helpers — the raw canonicalized path is never leaked into user-facing diagnostics. Callers see `null`, which flows to the `<resolution-failed>` sentinel path.

## Canonical `Violation` Shape

The public-API `Violation` record is frozen at exactly four fields:

```javascript
/**
 * @typedef {Object} Violation
 * @property {string}   file             - Absolute file path where the violation was found.
 * @property {string}   importSpecifier  - Raw import specifier text or expression text.
 * @property {string}   symbol           - Canonical blocklisted symbol or sentinel.
 * @property {string[]} pathToEntry      - Ordered list of files from entry point to violation site.
 */
```

The contract `contract-pure-compute-sub-check-api` output_shape (spec.md L221) and AC14.2 lock this shape. The matcher-internal `category` field must never appear on returned violations; the walker's canonical-shape aggregation strips it (AC6.15).

`importSpecifier` is the canonical field name. The public record intentionally does not expose an `import` field.

The black-box API contract test at `.claude/scripts/__tests__/pure-compute-api-contract.test.mjs` asserts `!('category' in v)` on every returned violation as a regression guard.

## Error Classes

### `PureComputeBlocklistViolation`

Structured error class for downstream consumers who want to bubble a single violation as an exception. Not thrown by `checkPureCompute` itself (which always returns a verdict).

**Constructor forms**:

```javascript
new PureComputeBlocklistViolation(message, options);
// or
new PureComputeBlocklistViolation({
  symbol,
  file,
  importSpecifier,
  pathToEntry,
});
```

**Fields**:

| Field             | Type        | Description                                       |
| ----------------- | ----------- | ------------------------------------------------- |
| `name`            | `string`    | `'PureComputeBlocklistViolation'`.                |
| `code`            | `string`    | Defaults to `'PURE_COMPUTE_BLOCKLIST_VIOLATION'`. |
| `blame`           | `string`    | `'client'`.                                       |
| `retry_safe`      | `boolean`   | `false`.                                          |
| `symbol`          | `string?`   | Blocklisted symbol or sentinel, when supplied.    |
| `file`            | `string?`   | Source file, when supplied.                       |
| `importSpecifier` | `string?`   | Raw import specifier, when supplied.              |
| `pathToEntry`     | `string[]?` | Entry-to-violation path, when supplied.           |

### `PureComputeResolutionError`

Structured error for resolution failures. Not thrown by `checkPureCompute` (which emits `<resolution-failed>` sentinels instead). Reserved for consumers who invoke the resolver directly.

**Constructor forms**: Same dual-form as `PureComputeBlocklistViolation`.

**Fields**:

| Field        | Type      | Description                                           |
| ------------ | --------- | ----------------------------------------------------- |
| `name`       | `string`  | `'PureComputeResolutionError'`.                       |
| `code`       | `string`  | Defaults to `'PURE_COMPUTE_RESOLUTION_ERROR'`.        |
| `blame`      | `string`  | `'self'`.                                             |
| `retry_safe` | `boolean` | `false`.                                              |
| `specifier`  | `string?` | The unresolved import specifier, when supplied.       |
| `fromFile`   | `string?` | The file that contained the specifier, when supplied. |
| `reason`     | `string?` | Free-form reason text, when supplied.                 |

## See Also

- [PURE-COMPUTE-CHECK.md](PURE-COMPUTE-CHECK.md) — High-level overview and Gate 5 integration
- [PURE-COMPUTE-CHECK-BLOCKLIST.md](PURE-COMPUTE-CHECK-BLOCKLIST.md) — Authoritative blocklist reference
- Contract: [`contract-pure-compute-sub-check-api`](../specs/groups/sg-e2e-pure-compute-check/spec.md#contract-pure-compute-sub-check-api-owner---this-workstream)
- Spec: [`.claude/specs/groups/sg-e2e-pure-compute-check/spec.md`](../specs/groups/sg-e2e-pure-compute-check/spec.md)
