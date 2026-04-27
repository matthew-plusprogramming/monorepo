---
_source_modules: ['scripts-lib', 'workflow-scripts']
last_reviewed: 2026-04-20
title: Bash Intent Classifier -- Library API Reference
---

# Bash Intent Classifier -- Library API Reference

Developer-facing reference for the pure-Node, stateless library at `.claude/scripts/lib/bash-intent-classifier.mjs`. Consumed by `.claude/scripts/workflow-file-protection.mjs` (PreToolUse Bash hook) and by tests.

See [`bash-intent-classifier.md`](./bash-intent-classifier.md) for architecture. See [`WORKFLOW-ENFORCEMENT.md`](./WORKFLOW-ENFORCEMENT.md) § Protected File Write Detection for how the classifier fits into enforcement.

---

## Table of Contents

- [Module Invariants](#module-invariants)
- [Exported Constants](#exported-constants)
- [classifyBashCommandIntent](#classifybashcommandintent)
- [classifyBashCommandIntentString](#classifybashcommandintentstring) (deprecated)
- [tokenizeBashCommand](#tokenizebashcommand)
- [normalizePath](#normalizepath)
- [parseInlineScriptBody](#parseinlinescriptbody)
- [registerVerb](#registerverb)
- [registerGitSubcommand](#registergitsubcommand)
- [Classifier Pipeline Order](#classifier-pipeline-order)
- [Type Definitions](#type-definitions)
- [Error Handling](#error-handling)

---

## Module Invariants

- Zero external dependencies; Node.js standard library only.
- Linear-time regular expressions throughout (no catastrophic-backtracking risk).
- Byte-length guard (`MAX_COMMAND_BYTES = 65536`) applied before parse.
- Recursion depth guard (`MAX_RECURSION_DEPTH = 2`) on command-substitution and inline-script bodies.
- Non-ASCII raw-byte scan runs **before** NFC normalization (homoglyph defense).
- Pure functions: no process state, no filesystem I/O, no command execution.
- `PROTECTED_FILENAMES` and `PROTECTED_FILENAME_PATTERNS` are re-exported from `workflow-file-protection.mjs`; this module does not own the list.

---

## Exported Constants

| Name                            | Type                                      | Description                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `MAX_COMMAND_BYTES`             | `number`                                  | `65536`. Commands longer than this fail closed with `reason: 'length_exceeded'`.                                                                                                                                                                                                                                                                                                                 |
| `MAX_RECURSION_DEPTH`           | `number`                                  | `2`. Depth exceeding this in `$(...)` / backtick / inline-script nesting fails closed.                                                                                                                                                                                                                                                                                                           |
| `READ_VERBS`                    | `Set<string>`                             | Read-only access-command allowlist. v2 extensions add `ls`, `echo`, `printf`, `test` to the baseline 23-verb set (required for the generic env-prefix strip path — `VAR=value ls session.json` must resolve to read after the prefix is stripped).                                                                                                                                               |
| `INLINE_RUNNER_VERBS`           | `Set<string>`                             | Verbs whose `-e` / `-c` / `eval` body is parsed for write-syscall intent: `node`, `python`, `python3`, `perl`, `ruby`, `deno`, `bun`, `sh`, `bash`.                                                                                                                                                                                                                                              |
| `PREFIX_STRIP_STRIP_TIER`       | `Set<string>`                             | Prefix verbs stripped before verb resolution: `sudo`, `nohup`, `timeout`, `stdbuf`, `nice`, `ionice`, `time`, `command`, `builtin`.                                                                                                                                                                                                                                                              |
| `PREFIX_STRIP_FAIL_CLOSED_TIER` | `Set<string>`                             | Prefix verbs that force fail-closed: `eval` (dynamic body cannot be statically analyzed).                                                                                                                                                                                                                                                                                                        |
| `PREFIX_STRIP_AMBIGUOUS_TIER`   | `Set<string>`                             | Prefix verbs whose dispatch model is uncertain: `xargs`, `find`, `coproc`.                                                                                                                                                                                                                                                                                                                       |
| `REDIRECTION_OPERATORS`         | `string[]`                                | `['>', '>>', '2>', '2>>', '&>', '&>>', '>                                                                                                                                                                                                                                                                                                                                                        | ', '<>']`. A redirect to a protected basename is always write-intent, regardless of verb. |
| `WRITE_SYSCALL_PATTERNS`        | `Readonly<Record<string, RegExp[]>>`      | Per-language write-syscall regex catalog. Keys: `node`, `python`, `perl`, `ruby`, `deno`, `bun`, `shell`.                                                                                                                                                                                                                                                                                        |
| `PROTECTED_FILENAMES`           | `string[]`                                | Re-exported from `workflow-file-protection.mjs`.                                                                                                                                                                                                                                                                                                                                                 |
| `PROTECTED_FILENAME_PATTERNS`   | `Array<{patternId, pattern, dirSegment}>` | Re-exported from `workflow-file-protection.mjs`.                                                                                                                                                                                                                                                                                                                                                 |

---

## classifyBashCommandIntent

Primary entry point. Accepts a Bash command string and returns a structured classification.

### Signature

```javascript
/**
 * @param {string} command
 * @returns {ClassificationResult}
 */
export function classifyBashCommandIntent(command)
```

### Parameters

| Name    | Type     | Required | Description                                                                                |
| ------- | -------- | -------- | ------------------------------------------------------------------------------------------ |
| command | `string` | Yes      | The raw Bash command string received from the PreToolUse Bash hook (`tool_input.command`). |

### Returns

`ClassificationResult` -- object of shape `{ intent, targets, reason? }`:

| Field     | Type                               | Description                                                                                                                     |
| --------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `intent`  | `'read' \| 'write' \| 'ambiguous'` | Classification verdict.                                                                                                         |
| `targets` | `ClassifiedTarget[]`               | Protected targets identified in the command. Populated only when `intent === 'write'`; empty for `'read'` and `'ambiguous'`.    |
| `reason`  | `FailReason` (optional)            | Present only when `intent === 'ambiguous'`. One of `'parse_failure'`, `'ambiguous'`, `'bypass_suspected'`, `'length_exceeded'`. |

Each `ClassifiedTarget` has `{ basename: string, matchType: 'exact' | 'pattern', source: 'positional' | 'redirection' | 'inline-script' | 'substitution' }`.

### Errors

This function never throws. Any internal exception (including malformed input) is caught and mapped to `{ intent: 'ambiguous', targets: [], reason: 'parse_failure' }`.

### Fail-Closed Guards (applied in order)

1. Byte length > `MAX_COMMAND_BYTES` -> `reason: 'length_exceeded'`.
2. Tokenizer / parse failure (unterminated quote, mismatched group, invalid heredoc delimiter) -> `reason: 'parse_failure'`.
3. INV-6 top-level substitution scan (Tier A unconditional, Tier B embedded) -> `reason: 'bypass_suspected'`.
4. Env-prefix denylist (§10.5a) -> `reason: 'bypass_suspected'`.
5. Non-ASCII byte, percent-encoded character, glob metachar, or `$VAR` / `$(...)` in a path token -> `reason: 'bypass_suspected'` or `reason: 'ambiguous'`.
6. Recursion depth > `MAX_RECURSION_DEPTH`, dynamic-body construct (`eval`, `new Function`, `__import__`), unknown compound short-flag char, or unrecognized inline-runner mentioning a protected basename -> `reason: 'ambiguous'`.

### Example

```javascript
import { classifyBashCommandIntent } from './.claude/scripts/lib/bash-intent-classifier.mjs';

// Read of a protected file -> allowed
const readResult = classifyBashCommandIntent(
  'cat .claude/context/session.json',
);
// readResult: { intent: 'read', targets: [] }

// Redirect to a protected file -> blocked
const writeResult = classifyBashCommandIntent(
  'echo x > .claude/context/session.json',
);
// writeResult: {
//   intent: 'write',
//   targets: [{ basename: 'session.json', matchType: 'exact', source: 'redirection' }]
// }

// Dynamically-constructed target -> fail-closed
const ambiguousResult = classifyBashCommandIntent(
  "node -e \"require('fs').writeFileSync(process.env.X, 'y')\"",
);
// ambiguousResult: { intent: 'ambiguous', targets: [], reason: 'ambiguous' }
```

---

## classifyBashCommandIntentString

Legacy string-returning helper. Retained for existing test consumers that import the three-value string contract; deprecated for new call sites.

### Signature

```javascript
/**
 * @param {string} command
 * @returns {'read' | 'write' | 'ambiguous'}
 */
export function classifyBashCommandIntentString(command)
```

### Parameters

| Name    | Type     | Required | Description                  |
| ------- | -------- | -------- | ---------------------------- |
| command | `string` | Yes      | The raw Bash command string. |

### Returns

`'read' | 'write' | 'ambiguous'` -- the `intent` field of `classifyBashCommandIntent(command)`. Target list and failure reason are discarded.

### Deprecation

New code MUST consume `classifyBashCommandIntent` so target information and fail-closed reason are preserved for telemetry and remediation messaging. Legacy callers migrate in place by reading `.intent` from the structured return.

### Example

```javascript
import { classifyBashCommandIntentString } from './.claude/scripts/lib/bash-intent-classifier.mjs';

const intent = classifyBashCommandIntentString('cat session.json');
// intent: 'read'
```

---

## tokenizeBashCommand

Low-level Bash command tokenizer. Useful for tests and advanced consumers that need to inspect segment boundaries, redirect operators, or heredoc delimiters without running the full classifier.

### Signature

```javascript
/**
 * @param {string} command
 * @returns {Token[]}
 */
export function tokenizeBashCommand(command)
```

### Parameters

| Name    | Type     | Required | Description                  |
| ------- | -------- | -------- | ---------------------------- |
| command | `string` | Yes      | The raw Bash command string. |

### Returns

`Token[]` -- a flat array of token objects. On parse failure, a single-element array `[{ type: 'parse-error', value: '', reason: FailReason }]` is returned instead of throwing.

Each `Token` has shape `{ type, value, unquoted?, quoteMode?, redirectOp?, redirectTarget?, heredocDelim?, heredocQuoted?, heredocTabStrip? }` where `type` is one of:

| Type                         | Meaning                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `word`                       | A command word (verb, argument, or path).                               |
| `redirect`                   | A redirection operator and its target (`redirectOp`, `redirectTarget`). |
| `chain`                      | A chaining operator: `;`, `&&`, `\|\|`, `\|`, `\|&`, `&`.               |
| `heredoc-body`               | The literal body of a heredoc.                                          |
| `group-open` / `group-close` | `(`, `)`, `{`, `}`.                                                     |
| `parse-error`                | Only returned on failure; carries `reason`.                             |

### Supported Shell Syntax

- Single, double, and ANSI-C (`$'...'`) quoting.
- Eight heredoc delimiter forms: `<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`, `<<-EOF`, `<<-'EOF'`, `<<-"EOF"`, `<<-\EOF`.
- Command substitution `$(...)`, backtick substitution `` `...` ``, arithmetic substitution `$((...))`, process substitution `<(...)` / `>(...)`.
- File-descriptor redirection forms: `N>`, `N>>`, `N<`, `N<>`, `N>&M`, `N<&M`, `>&M`, `<&M`.
- Comments (`#` to end of line at token boundary).

### Example

```javascript
import { tokenizeBashCommand } from './.claude/scripts/lib/bash-intent-classifier.mjs';

const tokens = tokenizeBashCommand('cat session.json | jq .phase');
// tokens: [
//   { type: 'word', value: 'cat', unquoted: 'cat', quoteMode: 'none' },
//   { type: 'word', value: 'session.json', unquoted: 'session.json', quoteMode: 'none' },
//   { type: 'chain', value: '|' },
//   { type: 'word', value: 'jq', unquoted: 'jq', quoteMode: 'none' },
//   { type: 'word', value: '.phase', unquoted: '.phase', quoteMode: 'none' },
// ]
```

---

## normalizePath

Normalize a raw path token to its basename, applying the eight-step strict-order normalization pipeline (SEC-004).

### Signature

```javascript
/**
 * @param {string} rawPath
 * @returns {{ basename: string | null, failClosed: boolean, reason?: FailReason }}
 */
export function normalizePath(rawPath)
```

### Parameters

| Name    | Type     | Required | Description                                                                                               |
| ------- | -------- | -------- | --------------------------------------------------------------------------------------------------------- |
| rawPath | `string` | Yes      | The raw path token (possibly quoted, ANSI-C-escaped, or containing glob / percent / variable constructs). |

### Returns

Object of shape `{ basename, failClosed, reason? }`:

- `basename` -- the extracted basename on success, or `null` when `failClosed === true`.
- `failClosed` -- `true` when normalization cannot produce a safe basename.
- `reason` -- populated when `failClosed === true`; one of `'parse_failure'`, `'bypass_suspected'`, `'ambiguous'`.

### Normalization Pipeline

The eight steps run in fixed order; do not reorder:

1. Strip surrounding ASCII quotes (single, double, ANSI-C `$'...'`).
2. Decode ANSI-C escapes (`\n`, `\t`, `\'`, `\"`, `\\`, `\0`) when quote mode is ANSI-C.
3. **Non-ASCII raw-byte scan** (before NFC) -- any byte > 0x7F fails closed with `reason: 'bypass_suspected'`.
4. NFC normalization (ASCII-safe, present for defence-in-depth).
5. Path-separator normalization (collapse `\` to `/`, dedupe, strip trailing).
6. Basename extraction (everything after the last `/`).
7. Platform-adaptive case policy (macOS / `darwin`: case-insensitive; Linux: case-sensitive; other: case-insensitive fallback).
8. Compare against `PROTECTED_FILENAMES` + `PROTECTED_FILENAME_PATTERNS` at the caller.

Additional fail-closed triggers applied between steps:

| Condition                                         | `reason`           |
| ------------------------------------------------- | ------------------ |
| Percent-encoded path (`%XX`)                      | `bypass_suspected` |
| Glob metachars (`*`, `?`, `[`, `]`, `{`, `}`)     | `bypass_suspected` |
| Command substitution in path (`$(...)`, backtick) | `ambiguous`        |
| Variable reference in path (`$VAR`, `${VAR}`)     | `ambiguous`        |

Tilde (`~`, `~user`) is treated as a literal character; `$HOME` is never expanded.

### Example

```javascript
import { normalizePath } from './.claude/scripts/lib/bash-intent-classifier.mjs';

normalizePath('"./session.json"');
// { basename: 'session.json', failClosed: false }

normalizePath('.claude/context/session\u2024json'); // U+2024 homoglyph
// { basename: null, failClosed: true, reason: 'bypass_suspected' }

normalizePath('$TARGET');
// { basename: null, failClosed: true, reason: 'ambiguous' }
```

---

## parseInlineScriptBody

Analyze the body of an inline-script runner invocation (`node -e`, `python -c`, `perl -e`, `ruby -e`, `deno eval`, `bun -e`, `sh -c`, `bash -c`) for write-syscall intent against protected files.

### Signature

```javascript
/**
 * @param {string} verb
 * @param {string} flag
 * @param {string} body
 * @returns {{ intent: Intent, targets: ClassifiedTarget[], reason?: FailReason }}
 */
export function parseInlineScriptBody(verb, flag, body)
```

### Parameters

| Name | Type     | Required | Description                                                                                                                                                  |
| ---- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| verb | `string` | Yes      | Lowercase runner verb (`'node'`, `'python'`, `'perl'`, `'ruby'`, `'deno'`, `'bun'`, `'sh'`, `'bash'`).                                                       |
| flag | `string` | Yes      | The inline-body flag that introduced the body (`'-e'`, `'-c'`, `'--eval'`, `'--command'`, `'eval'`). Informational; the body parse is the load-bearing step. |
| body | `string` | Yes      | The inline-script body (already quote-stripped by the tokenizer).                                                                                            |

### Returns

`{ intent, targets, reason? }` with the same semantics as `classifyBashCommandIntent`.

### Behavior

- `sh` / `bash`: body is recursively classified as a shell command (depth +1).
- Other runners: body is matched against `WRITE_SYSCALL_PATTERNS[language]` and `DYNAMIC_BYPASS_PATTERNS`.
- Write-syscall match + protected target in body path literals -> `intent: 'write'`.
- Dynamic-bypass construct (`eval(`, `new Function(`, `__import__`, computed property access on `require('fs')`, template-literal interpolation in method name) -> `intent: 'ambiguous'`, `reason: 'ambiguous'`.
- Unrecognized runner with protected basename in body -> `intent: 'ambiguous'`.
- Recursion past `MAX_RECURSION_DEPTH` -> `intent: 'ambiguous'`.

### Example

```javascript
import { parseInlineScriptBody } from './.claude/scripts/lib/bash-intent-classifier.mjs';

// Static write to a protected target -> blocked
parseInlineScriptBody(
  'node',
  '-e',
  "require('fs').writeFileSync('session.json', 'x')",
);
// { intent: 'write', targets: [{ basename: 'session.json', matchType: 'exact', source: 'inline-script' }] }

// Dynamic target -> fail-closed
parseInlineScriptBody('node', '-e', "require('fs').writeFileSync(path, 'x')");
// { intent: 'ambiguous', targets: [], reason: 'ambiguous' }

// Read-only body mentioning a protected name in a string literal -> allowed
parseInlineScriptBody('node', '-e', "console.log('session.json')");
// { intent: 'read', targets: [] }
```

---

## registerVerb

Register a verb's flag table in the declarative per-verb classifier (§10.6). Idempotent on deep-structural equality; throws on structurally-different re-registration.

### Signature

```javascript
/**
 * @param {string} verb
 * @param {FlagTable} flagTable
 * @returns {void}
 * @throws {Error}
 */
export function registerVerb(verb, flagTable)
```

### Parameters

| Name      | Type        | Required | Description                                                                     |
| --------- | ----------- | -------- | ------------------------------------------------------------------------------- |
| verb      | `string`    | Yes      | Lowercase verb basename (e.g., `'sed'`, `'tar'`, `'curl'`). Must be non-empty.  |
| flagTable | `FlagTable` | Yes      | Flag table describing write/read flags and target extraction behavior.          |

### `FlagTable` fields

| Field                       | Type                   | Required | Description                                                                                              |
| --------------------------- | ---------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `writeFlags`                | `string[]`             | Yes      | Flags that force `intent: 'write'` when present.                                                         |
| `readFlags`                 | `string[]`             | No       | Flags that force `intent: 'read'` (wins even over co-occurring write flags — AC-ITEM-3.4).               |
| `writeFlagPattern`          | `RegExp`               | No       | Regex form write flag (e.g., `/^-i[A-Za-z.]*$/` for sed `-i.bak`). Checked after literal miss.           |
| `readFlagPattern`           | `RegExp`               | No       | Regex form read flag (symmetric to `writeFlagPattern`).                                                  |
| `writeFlagsConsumingValue`  | `string[]`             | No       | Write flags whose next argv token is their value (consumed, skipped by flag scan).                       |
| `readFlagsConsumingValue`   | `string[]`             | No       | Read flags whose next argv token is their value.                                                         |
| `targetFromFlagValue`       | `string[]`             | No       | Flags whose value is treated as the target basename source (e.g., `sort -o FILE`, `tar -cf FILE`).       |
| `targetFromUrlBasename`     | `string[]`             | No       | Flags whose URL-valued argument's basename is the target (e.g., `curl -O URL`).                          |
| `default`                   | `'read' \| 'write'`    | Yes      | Default intent when no write/read flag matches. `'read'` for most tools; `'write'` for always-write verbs. |

### Equality Semantics (TECH-017 deep-structural)

Re-registration is idempotent iff the new `FlagTable` is deep-structurally equal to the stored entry. Comparison rules:

- **Arrays** (`writeFlags`, `readFlags`, `writeFlagsConsumingValue`, etc.): compared as **unordered Sets** (order-independent, duplicates collapsed).
- **Scalars** (`default` string, booleans, numbers): strict `===` equality.
- **RegExp** (`writeFlagPattern`, `readFlagPattern`): compared via `source` string + `flags` string (functional equivalence).
- **Objects**: field-by-field recursive comparison; `undefined`-valued fields ignored.

### Policy

- **Idempotent-if-identical**: calling `registerVerb('sed', table)` twice with structurally-identical `table` objects is a no-op.
- **Throws on structural difference**: calling `registerVerb('sed', t1)` then `registerVerb('sed', t2)` where `t1` and `t2` differ structurally throws `Error: registerVerb conflict for sed`.

### Reserved-name guard

Registrations for verbs in `BASH_WRITE_VERBS` (`cp`, `mv`, `rm`, `tee`, `ln`, `install`, `mkdir`, `rmdir`, `chmod`, `chown`, `touch`, `truncate`, `dd`, `rsync`, `unlink`) are always rejected, even on first registration:

```
Error: registerVerb: 'cp' is a reserved write-verb (in BASH_WRITE_VERBS). Reserved verbs cannot be registered with custom flag tables.
```

This prevents a shadow-registration bypass where a reserved write-verb could be re-declared with `default: 'read'`, which the `VERB_FLAG_TABLE` lookup would apply before the `BASH_WRITE_VERBS` check.

### Errors

| Error message                                                                                    | Condition                                                      |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `registerVerb: verb must be a non-empty string`                                                  | `verb` not a string, or empty string.                          |
| `registerVerb: flagTable must be an object`                                                      | `flagTable` null / not an object.                              |
| `registerVerb: flagTable.writeFlags must be an array`                                             | Missing or non-array `writeFlags`.                             |
| `registerVerb: flagTable.default must be 'read' or 'write'`                                      | Missing or invalid `default`.                                  |
| `registerVerb: '<verb>' is a reserved write-verb (in BASH_WRITE_VERBS). ...`                     | Verb is a member of `BASH_WRITE_VERBS`.                        |
| `registerVerb conflict for <verb>`                                                               | Prior registration exists with structurally-different table.   |

### Example

```javascript
import { registerVerb } from './.claude/scripts/lib/bash-intent-classifier.mjs';

// sed: -i and --in-place are write; -iSUFFIX variants match the regex pattern
registerVerb('sed', {
  writeFlags: ['-i', '--in-place'],
  writeFlagPattern: /^-i[A-Za-z.]*$/,
  readFlagsConsumingValue: ['-f'],
  default: 'read',
});

// curl: -o FILE (path-valued), -O URL (url-basename)
registerVerb('curl', {
  writeFlags: ['-o', '-O'],
  writeFlagsConsumingValue: ['-o', '-O'],
  targetFromFlagValue: ['-o'],
  targetFromUrlBasename: ['-O'],
  default: 'read',
});

// Second call with identical table -> no-op (idempotent)
registerVerb('sed', {
  writeFlags: ['-i', '--in-place'],
  writeFlagPattern: /^-i[A-Za-z.]*$/,
  readFlagsConsumingValue: ['-f'],
  default: 'read',
});

// Reserved-name rejection (always)
registerVerb('cp', { writeFlags: [], default: 'read' });
// throws: Error: registerVerb: 'cp' is a reserved write-verb ...
```

---

## registerGitSubcommand

Register a git subcommand entry in the declarative git subcommand registry (§10.1 / §10.2). Idempotent on tuple equality `(name, intent, variants-as-unordered-Set)`; throws on variant-overlap conflict.

### Signature

```javascript
/**
 * @param {string} name
 * @param {'read' | 'write-to-non-protected'} intent
 * @param {string[]} variants
 * @returns {void}
 * @throws {Error}
 */
export function registerGitSubcommand(name, intent, variants)
```

### Parameters

| Name     | Type                                    | Required | Description                                                                                          |
| -------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| name     | `string`                                | Yes      | Lowercase subcommand name (e.g., `'worktree'`, `'stash'`, `'bisect'`). Must be non-empty.            |
| intent   | `'read' \| 'write-to-non-protected'`    | Yes      | Intent classification for matching variants.                                                         |
| variants | `string[]`                              | Yes      | Variant tokens to match against the argv after the subcommand. `['*']` is a wildcard fallback.       |

### Wildcard (`'*'`) semantics

A `variants: ['*']` entry is a **fallback** applied only after literal-variant matching fails. It is **not** a collision with literal-variant entries for the same subcommand. Lookup pass order (read-first):

1. Pass 1: try literal variant match across all registered entries (read-intent entries checked before write entries).
2. Pass 2: if no literal hit, try any registered `['*']` entry.
3. Pass 3: if still no hit, caller falls back to §10.1a bare-form default (if applicable) or the legacy read/write subcommand sets.

### Multi-registration under the same name

A single subcommand name MAY be registered multiple times with **different** intents, provided variant sets do **not** overlap. Example — `bisect`:

```javascript
registerGitSubcommand('bisect', 'read', ['log', 'view', 'visualize', 'help']);
registerGitSubcommand('bisect', 'write-to-non-protected', [
  'start', 'good', 'bad', 'skip', 'reset', 'run', 'old', 'new', 'replay', 'terms',
]);
```

A third call like `registerGitSubcommand('bisect', 'read', ['start'])` would throw because `'start'` is already claimed by the write-intent entry.

### Policy

- **Idempotent-if-identical**: `registerGitSubcommand('worktree', 'read', ['list', 'prune'])` called twice with the same variant Set is a no-op.
- **Throws on structural difference (same name+intent, different variants)**: raises `Error: registerGitSubcommand conflict for <name>`.
- **Throws on variant overlap (same name, different intent)**: raises `Error: registerGitSubcommand conflict for <name>`.

### Errors

| Error message                                                           | Condition                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `registerGitSubcommand: name must be a non-empty string`                | `name` not a string, or empty string.                  |
| `registerGitSubcommand: intent must be 'read' or 'write-to-non-protected'` | Invalid `intent`.                                      |
| `registerGitSubcommand: variants must be an array`                       | `variants` not an array.                               |
| `registerGitSubcommand conflict for <name>`                             | Structural conflict (same name+intent, different set; OR variant overlap with different intent). |

### Example

```javascript
import { registerGitSubcommand } from './.claude/scripts/lib/bash-intent-classifier.mjs';

// Read-only: worktree list / prune / repair
registerGitSubcommand('worktree', 'read', ['list', 'prune', 'repair']);

// Write-to-non-protected: worktree add / remove / move
registerGitSubcommand('worktree', 'write-to-non-protected', [
  'add', 'remove', 'move',
]);

// Wildcard fallback: any `git rev-parse <anything>` is read
registerGitSubcommand('rev-parse', 'read', ['*']);

// Bisect sub-subcommands (disjoint intent sets)
registerGitSubcommand('bisect', 'read', ['log', 'view', 'visualize', 'help']);
registerGitSubcommand('bisect', 'write-to-non-protected', [
  'start', 'good', 'bad', 'skip', 'reset', 'run', 'old', 'new', 'replay', 'terms',
]);

// Second call with identical Set -> no-op
registerGitSubcommand('worktree', 'read', ['prune', 'list', 'repair']);

// Conflict — same name+intent, different variants
registerGitSubcommand('worktree', 'read', ['list']);
// throws: Error: registerGitSubcommand conflict for worktree
```

---

## Classifier Pipeline Order

Normative execution order for ITEM-4.5 / §10.5a semantics. Each stage's output is the next stage's input.

| Stage | Step                                       | Source reference               | Fail-closed reason |
| ----- | ------------------------------------------ | ------------------------------ | ------------------ |
| 1     | Tokenize                                   | `tokenizeInternal` / §Tokenizer | `parse_failure`    |
| 2     | INV-6 top-level substitution scan          | `anyTokenHasInv6TriggerTopLevel` / §INV-6 | `bypass_suspected` |
| 3     | Split segments on chain operators          | `splitSegments` / §Data Flow   | --                 |
| 4     | Check redirect targets                     | `classifySegment` redirect pass | depends on target  |
| 5     | Recurse into `$(...)` / backtick bodies    | `extractSubstitutionBodies`     | `ambiguous` at depth > 2 |
| 6     | Env-prefix strip with §10.5a denylist check | `stripPrefixes` / §Env Denylist | `bypass_suspected` |
| 7     | Verb lookup (`resolveVerbIntent`)          | `resolveVerbIntent`             | varies             |
| 8     | Git subcommand resolve (with §10.3 global-flag strip) | `resolveGitSubcommand` | `ambiguous` (unknown sub) |
| 9     | Declarative per-verb flag-aware classification (§10.6 + §10.6a compound expand) | `resolveDeclarativeVerb` | `ambiguous` (unknown compound char) |
| 10    | INV-6 override check (applies to `-m` body content) | `classifyInternal` | `bypass_suspected` |

Stage 2 (INV-6 top-level) runs **once** at depth 0 only. Recursive calls from substitution bodies (stage 5) do not re-run it — by construction, the recursive body is a stripped sub-command with no embedding context.

Stage 6 (env-prefix denylist) runs **after** the tightened env-prefix regex validation but **before** verb lookup, iterating left-to-right over contiguous leading env-prefix tokens.

Stage 10 (INV-6 override) ensures `-m` body contents do not smuggle command substitution into the classification even under the ITEM-5.2 UTF-8 body exemption.

---

## Type Definitions

```javascript
/**
 * @typedef {'parse_failure' | 'ambiguous' | 'bypass_suspected' | 'length_exceeded'} FailReason
 * @typedef {'read' | 'write' | 'ambiguous'} Intent
 * @typedef {'positional' | 'redirection' | 'inline-script' | 'substitution'} TargetSource
 * @typedef {'exact' | 'pattern'} MatchType
 * @typedef {{ basename: string, matchType: MatchType, source: TargetSource }} ClassifiedTarget
 * @typedef {{ intent: Intent, targets: ClassifiedTarget[], reason?: FailReason }} ClassificationResult
 *
 * @typedef {Object} FlagTable
 * @property {string[]} writeFlags
 * @property {string[]} [readFlags]
 * @property {RegExp}   [writeFlagPattern]
 * @property {RegExp}   [readFlagPattern]
 * @property {string[]} [writeFlagsConsumingValue]
 * @property {string[]} [readFlagsConsumingValue]
 * @property {string[]} [targetFromFlagValue]
 * @property {string[]} [targetFromUrlBasename]
 * @property {'read' | 'write'} default
 */
```

### Fail-Reason Enum

| `reason`           | Meaning                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `parse_failure`    | Tokenizer could not produce a valid token stream (unterminated quote, unbalanced group, malformed heredoc). |
| `ambiguous`        | Dynamic construct, excessive recursion, variable reference, or unknown compound short-flag char defeats static analysis. |
| `bypass_suspected` | Non-ASCII byte, percent-encoding, glob in a path, env-var denylist match (§10.5a), or INV-6 substitution trigger -- conservative block. |
| `length_exceeded`  | Command exceeds `MAX_COMMAND_BYTES` (64 KB).                                                                |

### Target-Source Enum

| `source`        | Meaning                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `positional`    | Protected basename appeared as a positional argument to a write verb (`tee`, `cp`, `mv`, etc.).     |
| `redirection`   | Protected basename was the target of a redirect operator (`>`, `>>`, etc.).                         |
| `inline-script` | Protected basename was a string-literal path inside an inline-script body (`node -e`, `python -c`). |
| `substitution`  | Protected basename was reached via a recursed command-substitution body (`$(...)`, backtick).       |

---

## Error Handling

| Call                              | On Error                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `classifyBashCommandIntent`       | Returns `{ intent: 'ambiguous', targets: [], reason: 'parse_failure' }`. Never throws. |
| `classifyBashCommandIntentString` | Returns `'ambiguous'`. Never throws.                                                   |
| `tokenizeBashCommand`             | Returns `[{ type: 'parse-error', value: '', reason }]`. Never throws.                  |
| `normalizePath`                   | Returns `{ basename: null, failClosed: true, reason }`. Never throws.                  |
| `parseInlineScriptBody`           | Returns `{ intent: 'ambiguous', targets: [], reason }` on failure. Never throws.       |
| `registerVerb`                    | Throws synchronously on invalid input, reserved-name rejection, or structural conflict. |
| `registerGitSubcommand`           | Throws synchronously on invalid input or variant-overlap / structural conflict.        |

`classifyBashCommandIntent`, `classifyBashCommandIntentString`, `tokenizeBashCommand`, `normalizePath`, and `parseInlineScriptBody` are pure functions with no filesystem, network, or process side effects. `registerVerb` and `registerGitSubcommand` mutate the module-local registries (`VERB_FLAG_TABLE`, `GIT_SUBCOMMAND_REGISTRY`); the hook is responsible for emitting telemetry and exiting, the library only classifies.

---

## See Also

- [`bash-intent-classifier.md`](./bash-intent-classifier.md) -- architecture and data flow.
- [`WORKFLOW-ENFORCEMENT.md`](./WORKFLOW-ENFORCEMENT.md) -- enforcement layer context.
- [`HOOKS.md`](./HOOKS.md) § PreToolUse Hooks (Write / Bash - Enforcement File Protection).
