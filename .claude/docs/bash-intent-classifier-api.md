---
_source_modules: ['scripts-lib', 'workflow-scripts']
last_reviewed: 2026-04-27
title: Bash Intent Classifier - Library API Reference
---

# Bash Intent Classifier - Library API Reference

API reference for `.claude/scripts/lib/bash-intent-classifier.mjs`. For runtime
behavior and hook integration, see
[`bash-intent-classifier.md`](./bash-intent-classifier.md),
[`WORKFLOW-ENFORCEMENT.md`](./WORKFLOW-ENFORCEMENT.md), and
[`HOOKS.md`](./HOOKS.md).

## Invariants

- Pure classifier functions do not read files, run commands, or use network I/O.
- The module uses Node.js standard library only.
- Command byte length is checked before parse: `MAX_COMMAND_BYTES = 65536`.
- Command substitution and inline-script recursion fail closed past
  `MAX_RECURSION_DEPTH = 2`.
- Non-ASCII raw bytes are rejected before NFC normalization.
- `PROTECTED_FILENAMES` and `PROTECTED_FILENAME_PATTERNS` are re-exported from
  `workflow-file-protection.mjs`; this module does not own the protected set.

## Export Surface

Functions:

| Export | Purpose |
| --- | --- |
| `classifyBashCommandIntent(command)` | Primary classifier. Returns `{ intent, targets, reason? }`. |
| `classifyBashCommandIntentString(command)` | Legacy helper returning only `'read'`, `'write'`, or `'ambiguous'`. |
| `tokenizeBashCommand(command)` | Public tokenizer for tests and diagnostics. |
| `normalizePath(rawPath)` | Strict protected-target basename normalization. |
| `parseInlineScriptBody(verb, flag, body)` | Inline runner body classifier. |
| `registerVerb(verb, flagTable)` | Register a declarative verb flag table. |
| `registerGitSubcommand(name, intent, variants)` | Register git subcommand intent variants. |

Exported constants:

| Export | Contract |
| --- | --- |
| `MAX_COMMAND_BYTES` | `65536`; larger commands return `length_exceeded`. |
| `MAX_RECURSION_DEPTH` | `2`; deeper nested bodies return `ambiguous`. |
| `READ_VERBS` | Read-only verbs such as `cat`, `rg`, `jq`, `awk`, `ls`, `echo`, `printf`, `test`. |
| `INLINE_RUNNER_VERBS` | `node`, `python`, `python3`, `perl`, `ruby`, `deno`, `bun`, `sh`, `bash`. |
| `PREFIX_STRIP_STRIP_TIER` | Prefixes stripped before verb resolution: `sudo`, `nohup`, `timeout`, `stdbuf`, `nice`, `ionice`, `time`, `command`, `builtin`. |
| `PREFIX_STRIP_FAIL_CLOSED_TIER` | Dynamic prefixes that fail closed, currently `eval` plus `env -i` handling. |
| `PREFIX_STRIP_AMBIGUOUS_TIER` | Uncertain dispatch prefixes: `xargs`, `find`, `coproc`. |
| `REDIRECTION_OPERATORS` | Write redirections: `>`, `>>`, `2>`, `2>>`, `&>`, `&>>`, `>|`, `<>`. |
| `WRITE_SYSCALL_PATTERNS` | Inline-runner write syscall regex catalogs. |
| `PROTECTED_FILENAMES` / `PROTECTED_FILENAME_PATTERNS` | Re-exported protected target set. |

## Types

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
 * @property {RegExp} [writeFlagPattern]
 * @property {RegExp} [readFlagPattern]
 * @property {string[]} [writeFlagsConsumingValue]
 * @property {string[]} [readFlagsConsumingValue]
 * @property {string[]} [targetFromFlagValue]
 * @property {string[]} [targetFromUrlBasename]
 * @property {'read' | 'write'} default
 */
```

## classifyBashCommandIntent

```javascript
export function classifyBashCommandIntent(command)
```

Returns `ClassificationResult`:

| Field | Meaning |
| --- | --- |
| `intent: 'read'` | No protected write target was found. |
| `intent: 'write'` | A protected target was identified in a write context. |
| `intent: 'ambiguous'` | Static analysis could not prove the command safe; hook blocks. |
| `targets` | Populated for write results with `{ basename, matchType, source }`. |
| `reason` | Populated for ambiguous results. |

The function never throws. Internal errors map to:

```javascript
{ intent: 'ambiguous', targets: [], reason: 'parse_failure' }
```

Fail-closed reasons:

| Reason | Trigger |
| --- | --- |
| `length_exceeded` | Command exceeds `MAX_COMMAND_BYTES`. |
| `parse_failure` | Unterminated quote, unbalanced group, malformed heredoc, or tokenizer failure. |
| `bypass_suspected` | Non-ASCII raw byte, percent encoding, glob in path, denied env prefix, or top-level substitution trigger. |
| `ambiguous` | Dynamic body, unresolved variable path, recursion too deep, unknown compound flag char, uncertain dispatch model. |

Example:

```javascript
import { classifyBashCommandIntent } from './.claude/scripts/lib/bash-intent-classifier.mjs';

classifyBashCommandIntent('cat .claude/context/session.json');
// { intent: 'read', targets: [] }

classifyBashCommandIntent('echo x > .claude/context/session.json');
// { intent: 'write', targets: [{ basename: 'session.json', matchType: 'exact', source: 'redirection' }] }
```

## classifyBashCommandIntentString

```javascript
export function classifyBashCommandIntentString(command)
```

Legacy compatibility helper. It returns only the `intent` field from
`classifyBashCommandIntent(command)` and discards targets and reason. New call
sites should use the structured result.

## tokenizeBashCommand

```javascript
export function tokenizeBashCommand(command)
```

Returns token objects for words, redirects, chain operators, heredoc bodies,
groups, and parse errors. On parse failure it returns:

```javascript
[{ type: 'parse-error', value: '', reason }]
```

Supported syntax includes single/double/ANSI-C quotes, heredocs, command and
process substitution, arithmetic substitution, file descriptor redirects,
groups, chain operators, and token-boundary comments.

## normalizePath

```javascript
export function normalizePath(rawPath)
```

Returns:

```javascript
{ basename: string | null, failClosed: boolean, reason?: FailReason }
```

Normalization order is load-bearing:

1. Strip surrounding ASCII quotes.
2. Decode ANSI-C escapes for `$'...'`.
3. Reject non-ASCII raw bytes before NFC.
4. Apply NFC normalization.
5. Normalize path separators.
6. Extract basename.
7. Apply platform case policy.
8. Caller compares against protected exact and pattern targets.

Percent encoding and glob metacharacters return `bypass_suspected`. Variable
references and command substitution in a path return `ambiguous`. Tilde and
`$HOME` are not expanded.

## parseInlineScriptBody

```javascript
export function parseInlineScriptBody(verb, flag, body)
```

Classifies inline runner bodies introduced by `-e`, `-c`, `--eval`,
`--command`, or `eval`.

- `sh` and `bash` bodies recurse through the shell classifier.
- `node`, `python`, `perl`, `ruby`, `deno`, and `bun` bodies use
  `WRITE_SYSCALL_PATTERNS`.
- Static write syscall plus protected literal target returns `write`.
- Dynamic code execution or computed filesystem access returns `ambiguous`.
- Unrecognized runner plus protected basename returns `ambiguous`.

## registerVerb

```javascript
export function registerVerb(verb, flagTable)
```

Registers a declarative flag table. Re-registering an identical table is a
no-op; structural conflicts throw synchronously.

Flag-table rules:

- `writeFlags` is required.
- `default` must be `'read'` or `'write'`.
- `readFlags` beat co-occurring write flags.
- `writeFlagPattern` and `readFlagPattern` are compared by `source` and
  `flags`.
- Array fields compare as unordered sets for idempotency.
- `targetFromFlagValue` treats a flag value as a protected-target candidate.
- `targetFromUrlBasename` extracts the basename from a URL path.

Registrations for reserved write verbs such as `cp`, `mv`, `rm`, `tee`, `ln`,
`install`, `mkdir`, `chmod`, `chown`, `touch`, `truncate`, `dd`,
`rsync`, and `unlink` are rejected even on first registration.

## registerGitSubcommand

```javascript
export function registerGitSubcommand(name, intent, variants)
```

Registers git subcommand variants as either `'read'` or
`'write-to-non-protected'`.

- Identical re-registration is a no-op.
- Same name and intent with a different variant set throws.
- Same name with different intent and overlapping variants throws.
- `['*']` is a wildcard fallback after literal variants fail.
- Literal read variants are checked before literal write variants.

## Pipeline Order

1. Check command byte length.
2. Tokenize.
3. Run top-level substitution/bypass scan.
4. Split on chain operators.
5. Check redirects.
6. Recurse into substitution bodies.
7. Strip prefixes and denied env assignments.
8. Resolve verb and git subcommand/global flags.
9. Apply declarative flag-aware classification.
10. Apply final substitution override checks for message-body exemptions.

## Error Behavior

| Call | Failure behavior |
| --- | --- |
| `classifyBashCommandIntent` | Returns ambiguous `ClassificationResult`; never throws. |
| `classifyBashCommandIntentString` | Returns `'ambiguous'`; never throws. |
| `tokenizeBashCommand` | Returns a `parse-error` token; never throws. |
| `normalizePath` | Returns `{ basename: null, failClosed: true, reason }`; never throws. |
| `parseInlineScriptBody` | Returns ambiguous result; never throws. |
| `registerVerb` | Throws on invalid input, reserved verb, or conflict. |
| `registerGitSubcommand` | Throws on invalid input or conflict. |

## See Also

- [`bash-intent-classifier.md`](./bash-intent-classifier.md) - runtime behavior.
- [`WORKFLOW-ENFORCEMENT.md`](./WORKFLOW-ENFORCEMENT.md) - protected-file enforcement.
- [`HOOKS.md`](./HOOKS.md) - PreToolUse hook placement.
