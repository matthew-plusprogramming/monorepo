---
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
title: Pure-Compute Static-Analysis Sub-Check API
last_reviewed: 2026-04-27
---

# Pure-Compute Static-Analysis Sub-Check API

API reference for `.claude/scripts/lib/pure-compute-*.mjs` and
`path-containment.mjs`. These are ES modules. The stable consumer surface is
`checkPureCompute`; the other modules are direct imports for tests and internal
workflow code.

## `pure-compute-static-check.mjs`

### `checkPureCompute(params)`

```js
async function checkPureCompute({
  specId,
  entryPoints,
  tsconfigPath,
}) => Promise<{verdict, violations}>
```

Parameters:

| Field | Contract |
| --- | --- |
| `specId` | Non-empty string. |
| `entryPoints` | Non-empty string array of absolute or cwd-relative paths. |
| `tsconfigPath` | Optional string. Omitted and explicit `undefined` are equivalent. |

Returns:

| Field | Contract |
| --- | --- |
| `verdict` | `pass` or `fail`; `fail` exactly when at least one violation exists. |
| `violations` | Array of canonical violation records. |

Invalid input throws a Zod validation error through
`CheckPureComputeInputSchema`. Analysis problems return sentinel violations
instead of throwing.

Exports:

| Export | Role |
| --- | --- |
| `CheckPureComputeInputSchema` | Zod boundary schema. |
| `PureComputeBlocklistViolation` | Structured error class for consumers that want exception-style reporting. Not thrown by `checkPureCompute`. |
| `PureComputeResolutionError` | Structured resolver error class for direct resolver consumers. Not thrown by `checkPureCompute`. |
| `formatViolation`, `formatViolations` | Re-exported formatter helpers. |

## Canonical Violation

Public violations have exactly four fields:

```js
{
  file: string,
  importSpecifier: string,
  symbol: string,
  pathToEntry: string[],
}
```

The matcher may create an internal `category` field, but the walker strips it
before returning API results. Public records do not expose an `import` alias.

## `pure-compute-resolver.mjs`

Exports:

| Export | Contract |
| --- | --- |
| `RESOLVER_EXTENSIONS` | `['.mjs', '.ts', '.tsx', '.js', '.jsx', '.json']`. |
| `loadTsconfig(tsconfigPath, options?)` | Returns `{paths, baseUrl, path}`. Missing, undefined, or malformed tsconfig degrades to an empty model. |
| `resolveSpecifier(specifier, fromFile, tsconfig)` | Returns an absolute contained path or `null`. |

Resolution order:

1. Relative specifiers from the importing file directory.
2. Absolute specifiers as given.
3. tsconfig path aliases in declaration order, with exact keys before wildcard
   keys and longer prefixes preferred.
4. `null` for unresolved bare specifiers.

Directory imports try `index.*`. File imports try `RESOLVER_EXTENSIONS`.

When `tsconfig.projectRoot` is set, every candidate passes through
`assertContainment`. Escapes return `null`, which becomes a
`<resolution-failed>` violation in the walker.

Bare node builtins and package imports are not resolved here; the matcher
classifies those specifiers.

## `pure-compute-extractor.mjs`

Exports:

| Export | Contract |
| --- | --- |
| `extractImports(filePath)` | Reads a file and returns imports, re-exports, dynamic imports, type-only count, and `parseError`. Read failures become `parseError`. |
| `extractFromSource(source, filePath)` | Same extraction from in-memory source text. |
| `parseSourceToAst(source, filePath)` | Returns a TypeScript `SourceFile` for scanner reuse. |

Result shape:

```js
{
  imports,
  reexports,
  dynamicImports,
  typeOnlyCount,
  parseError,
}
```

`imports` include default, namespace, and named bindings with whole-declaration
and per-specifier type-only flags. Re-exports include `export * from`,
`export {x} from`, and namespace-export forms. Dynamic imports keep the raw
argument text for diagnostics.

## `pure-compute-scanner.mjs`

### `scanCallSites(sourceFile, importRecords)`

Returns callsite records:

```js
{symbol, importSpecifier, nodeText, span: {line, column}}
```

Scanner coverage:

| Pattern | Symbol |
| --- | --- |
| `fs.writeFile`, `fs.writeFileSync`, `fs.appendFile`, `fs.rename`, `fs.unlink` | `fs.<method>` |
| `fs.promises.writeFile`, `fs.promises.rename`, `fs.promises.unlink` | `fs.promises.<method>` |
| `os.networkInterfaces()` | `os.networkInterfaces` |
| `process.exit()` | `process.exit` |
| `eval(...)`, `globalThis.eval(...)` | `eval` |
| `Function(...)`, `new Function(...)`, `globalThis.Function(...)` | `Function` |
| `AsyncFunction(...)`, `GeneratorFunction(...)` | Matching constructor name |
| Reflected async or generator constructors | `AsyncFunction-via-reflection`, `GeneratorFunction-via-reflection` |
| `setTimeout` or `setInterval` with string-like first arg | `setTimeout-string-arg`, `setInterval-string-arg` |
| Module-scope `fetch(...)` | `fetch` |

Namespace and default imports are tracked for `fs`, `fs/promises`, and `os`,
including `node:` forms. `fetch` inside a function body is allowed. Matches are
deduplicated by line, column, and symbol.

## `pure-compute-matcher.mjs`

Exports:

| Export | Contract |
| --- | --- |
| `MODULE_BLOCKLIST` | Frozen map of normalized module specifier to category. |
| `SAFELIST` | Frozen set containing `perf_hooks`. |
| `normalizeSpecifier(specifier)` | Removes `node:` prefix; non-strings return `''`. |
| `isSafeList(specifier)` | True for `perf_hooks` and `node:perf_hooks`. |
| `matchBlocklist(params)` | Converts module specifiers, scanner callsites, and dynamic imports into matcher violations. |
| `makeResolutionFailedViolation({file, importSpecifier})` | Builds `<resolution-failed>`. |
| `makeParseErrorViolation({file})` | Builds `<parse-error>`. |

`matchBlocklist` accepts:

```js
{
  specifier,
  callSites,
  dynamicImports,
  file,
}
```

It emits intermediate records:

```js
{symbol, importSpecifier, category, span, file}
```

`category` is internal and is stripped by the walker.

## `pure-compute-walker.mjs`

### `walkGraph(params)`

```js
async function walkGraph({
  entryPoints,
  tsconfigPath,
}) => Promise<{visited, violations, cycles}>
```

Returns:

| Field | Contract |
| --- | --- |
| `visited` | `Map<string, 'in-progress' | 'finalized'>`. |
| `violations` | Canonical four-field violation records. |
| `cycles` | Array of `Set<string>` cycle classes detected during DFS. |

Traversal:

- Entry points are normalized to absolute paths.
- Project root is `tsconfig.baseUrl`, else the longest common ancestor of
  entry-point directories, else the first entry directory.
- The project root is canonicalized with `realpathSync`.
- Entry-point containment is enforced only when the root came from tsconfig.
- Static imports and re-exports are sorted by specifier before recursion.
- Type-only imports are skipped.
- Cycle classes are merged, and non-sentinel blocklist violations propagate to
  all cycle members.
- `<resolution-failed>` and `<parse-error>` remain file-local.

Fail-closed behavior:

| Condition | Violation |
| --- | --- |
| Resolver returns `null` for a relative, absolute, or escaped candidate | `<resolution-failed>` |
| File read fails | `<parse-error>` |
| Extractor reports syntax diagnostics | `<parse-error>` |
| Dynamic import exists | `<dynamic-import>` |

## `pure-compute-formatter.mjs`

Exports:

| Export | Contract |
| --- | --- |
| `formatViolation(violation)` | Returns one plain-text diagnostic line. Does not mutate input. |
| `formatViolations(violations)` | Joins formatted diagnostics with newlines. Empty or non-array input returns `''`. |

Special symbol phrasing:

| Symbol | Phrase |
| --- | --- |
| `<dynamic-import>` | `uses dynamic import(...)` |
| `<resolution-failed>` | `could not resolve import ...` |
| `<parse-error>` | `parse error in ...` |

Formatter output contains no ANSI escapes.

## `path-containment.mjs`

Exports:

| Export | Contract |
| --- | --- |
| `assertContainment(target, claudeRoot)` | Realpaths `target` and verifies it equals `claudeRoot` or starts with `claudeRoot + path.sep`. Returns the resolved path. |
| `PathEscapeError` | Structured error with `name`, `code: 'PATH_ESCAPE'`, `rule: 'path-escape'`, `target`, `resolved`, and `claudeRoot`. |

The trailing-separator check prevents prefix collisions such as
`.claude-evil` being accepted as a child of `.claude`.

Pure-compute callers catch `PathEscapeError`, return `null`, and let the walker
emit `<resolution-failed>` without leaking canonicalized filesystem paths.

## See Also

- [PURE-COMPUTE-CHECK.md](PURE-COMPUTE-CHECK.md)
- [PURE-COMPUTE-CHECK-BLOCKLIST.md](PURE-COMPUTE-CHECK-BLOCKLIST.md)
