---
_source_modules: ['scripts-lib', 'workflow-scripts']
last_reviewed: 2026-04-20
title: Bash Intent Classifier -- Architecture
---

# Bash Intent Classifier -- Architecture

Structured, argument-position-granular classifier that decides whether a Bash command invocation reads or writes a protected enforcement file. Replaces the prior substring-scan over-matcher in `.claude/scripts/workflow-file-protection.mjs`.

Library: `.claude/scripts/lib/bash-intent-classifier.mjs`. API reference: [`bash-intent-classifier-api.md`](./bash-intent-classifier-api.md). Integration context: [`WORKFLOW-ENFORCEMENT.md`](./WORKFLOW-ENFORCEMENT.md) and [`HOOKS.md`](./HOOKS.md).

---

## Purpose

Gate PreToolUse Bash invocations against writes to protected enforcement files (`session.json`, kill-switch sentinels, deployment-intervention audit log, and others listed in `PROTECTED_FILENAMES`). The gate must be permissive enough to avoid blocking legitimate reads that merely mention a protected filename, and strict enough that every credible write vector is caught.

---

## Problem

The prior hook implementation scanned the raw Bash command string for two signals:

1. Presence of any write-operator regex (`>`, `tee`, `cp`, `mv`, `sed -i`, `node -e`, `python`, etc.).
2. Substring presence of any `PROTECTED_FILENAMES` entry anywhere in the command.

When both matched, the hook blocked. This over-matched in every case where a protected filename appeared in a read context alongside an unrelated write operator:

| Blocked command                                                                          | Actual intent  |
| ---------------------------------------------------------------------------------------- | -------------- |
| `cat .claude/context/session.json`                                                       | Read           |
| `git commit -m "update session.json handling"`                                           | Commit message |
| `jq .phase session.json \| node -e "console.log(require('fs').readFileSync(0, 'utf8'))"` | Read + read    |
| `grep session.json .claude/**/*.md`                                                      | Text search    |
| `rg -n "session\.json" src/`                                                             | Text search    |

The live-session repro (`jq .phase session.json | node -e ...`) blocked an interactive debugging flow. Commit messages referencing a protected filename blocked `git commit`. Any documentation edit mentioning `session.json` as a literal string triggered the hook.

Under-matching also existed. The substring scan ignored argument position: `tee session.json` (write) and `cat session.json` (read) looked identical to the scanner once both matched `session.json`.

---

## Solution

Replace substring scan with a four-stage structured classifier:

1. **Tokenizer** -- convert the Bash command string into a typed token stream (`word`, `redirect`, `chain`, `heredoc-body`, `group-open`, `group-close`).
2. **Segment split + verb resolution** -- split on chaining operators (`;`, `&&`, `||`, `|`, `|&`, `&`), strip prefix verbs (`sudo`, `nohup`, `env VAR=x`, ...), resolve the real verb per segment.
3. **Per-segment intent classification** -- each segment is read, write, or ambiguous based on its verb, its redirect operators, and (for inline runners) its body.
4. **Fail-closed guards** -- length, recursion depth, non-ASCII bytes, percent-encoding, glob, and dynamic-bypass constructs all force `intent: 'ambiguous'` with a typed `reason`.

All-segment disposition: if any segment classifies as write, the command is write-intent. If no segment is write but any segment is ambiguous, the command is ambiguous. Otherwise read.

---

## Before vs After

Live-session repro (previously blocked by substring scan):

```bash
cat .claude/context/session.json | node -e "console.log(require('fs').readFileSync(0, 'utf8'))"
```

**Before**: matches `/\bnode\b.*-e\b/` (write-operator regex) and substring `session.json` -> BLOCKED.

**After**: classifier produces `{ intent: 'read', targets: [] }`.

- Segment 1: `cat .claude/context/session.json` -- verb `cat` is in `READ_VERBS` -> read.
- Segment 2: `node -e "console.log(require('fs').readFileSync(0, 'utf8'))"` -- inline-script body has no write-syscall regex match; `readFileSync` is read -> read.
- No redirects, no heredocs, no write targets -> `intent: 'read'`.

Symmetric negative case (correctly still blocked):

```bash
echo '{"phase":"bypass"}' > .claude/context/session.json
```

Classifier produces `{ intent: 'write', targets: [{ basename: 'session.json', matchType: 'exact', source: 'redirection' }] }`. Redirect target normalizes to a protected basename -> write.

---

## Data Flow

```
Bash command string (tool_input.command)
  -> Byte-length guard (64 KB)              [fail-closed: length_exceeded]
  -> tokenizeInternal                       [fail-closed: parse_failure]
  -> INV-6 top-level substitution scan      [fail-closed: bypass_suspected]
  -> splitSegments (by chain operators)
  -> For each segment:
       -> Check redirects                   [fail-closed: ambiguous | bypass_suspected]
       -> Recurse into $(...) bodies        [fail-closed: ambiguous at depth > 2]
       -> stripPrefixes                     [fail-closed: env denylist, env -i, eval, xargs, find, coproc]
       -> resolveVerbIntent (verb + args)
            -> exec form 1/2/3
            -> git subcommand-aware (with §10.3 global-flag strip)
            -> Declarative per-verb flag table (§10.6)
            -> Inline runners -> parseInlineScriptBody
            -> Read-verb allowlist -> read
            -> Write-verb set -> write + scanWriteVerbPositionals
       -> normalizePath for any targets     [8-step strict-order normalization]
  -> Combine segment verdicts (ALL-SEGMENT)
  -> Return { intent, targets, reason? }

Hook consumes the return:
  intent='read'      -> exit 0 (allow)
  intent='write'     -> PPID exemption check (mixed exact+pattern denial)
                        -> allow iff all targets are pattern-match AND parent is audit-append.mjs
                        -> otherwise block (exit 2, BLOCKED message)
  intent='ambiguous' -> writeSync(2, 'HOOK_CLASSIFIER_FAIL_CLOSED: reason=... verb=... length=...')
                        -> exit 2 (block)
```

Classifier pipeline order (normative): **tokenize → INV-6 top-level scan → env-prefix strip (denylist check) → verb lookup → subcommand resolve (with global-flag strip) → flag-aware classification → INV-6 override check**.

---

## v2: Git Subcommand Expansion

The v2 refactor moves git subcommand intent from inline switch statements into declarative registry entries (`registerGitSubcommand(name, intent, variants)`). The pre-existing legacy sets (`GIT_LEGACY_READ_SUBCOMMANDS`, `GIT_LEGACY_WRITE_SUBCOMMANDS`) are retained as a backward-compatibility fallback after registry lookup.

### Extended read subcommands

These subcommands and variants classify as **read** (allow):

| Subcommand  | Read variants                    |
| ----------- | -------------------------------- |
| `worktree`  | `list`, `prune`, `repair`        |
| `stash`     | `list`, `show`                   |
| `remote`    | `show`, `-v`, `get-url`          |
| `tag`       | `-l`, `--list`                   |
| `config`    | `--get`, `-l`, `--list`          |
| `rev-parse` | any (`*` wildcard)               |
| `describe`  | any (`*` wildcard)               |
| `rev-list`  | any (`*` wildcard)               |
| `reflog`    | any (`*` wildcard)               |
| `fsck`      | any (`*` wildcard)               |
| `clean`     | `-n`, `--dry-run`                |

### Extended write-to-non-protected subcommands

These classify as **write** but without a protected target, so the hook allows them (no protected basename in play):

| Subcommand | Write-to-non-protected variants |
| ---------- | ------------------------------- |
| `worktree` | `add`, `remove`, `move`         |
| `stash`    | `push`, `pop`, `drop`           |
| `remote`   | `add`, `remove`                 |
| `clean`    | `-i` (interactive), any (`*`)   |
| `tag`      | any (`*` wildcard)              |
| `gc`       | any (`*` wildcard)              |

### §10.1a Bare-form defaults

When a subcommand appears with no following variant token, the bare-form default table applies. Applied **before** the wildcard (`['*']`) fallback registry pass.

| Bare form      | Intent                   |
| -------------- | ------------------------ |
| `git stash`    | write-to-non-protected   |
| `git tag`      | read                     |
| `git config`   | read                     |
| `git bisect`   | read                     |

### §10.1b Bisect sub-subcommand table

`git bisect` is registered twice (same name, disjoint variant sets, different intents):

| Variant                                                                   | Intent                  |
| ------------------------------------------------------------------------- | ----------------------- |
| `log`, `view`, `visualize`, `help`                                        | read                    |
| `start`, `good`, `bad`, `skip`, `reset`, `run`, `old`, `new`, `replay`, `terms` | write-to-non-protected |

Footnote: `git bisect start -- <path>` with `<path>` matching a protected basename promotes to **write-to-protected** (target captured from trailing positionals after `--`).

---

## v2: Git Global-Flag Strip (§10.3)

Runs **before** `resolveGitSubcommand` so subcommand lookup starts after the real subcommand token. Loops until no leading global flag matches.

| Flag                   | Accepts = form | Accepts space form | Consumes value |
| ---------------------- | -------------- | ------------------ | -------------- |
| `-C`                   | No             | Yes                | Yes            |
| `--git-dir`            | Yes            | Yes                | Yes            |
| `--work-tree`          | Yes            | Yes                | Yes            |
| `-c`                   | No             | Yes                | Yes (`key=value`) |
| `--no-pager`           | n/a            | n/a                | No             |
| `--no-optional-locks`  | n/a            | n/a                | No             |

Loop semantics: after each match, advance the token index (by 1 for no-value flags, by 2 for space-form value flags, by 1 for equals-form) and re-test the next token. Stops at first non-matching word. A dangling value-consuming flag with no value token also stops (conservative).

Example: `git -C /tmp --no-pager --git-dir=.git worktree list` → strips to `worktree list` for subcommand lookup.

---

## v2: Declarative Per-Verb Flag Table (§10.6)

Per-verb write/read flags are now data-driven via `registerVerb(verb, flagTable)`. Flag-table fields: `writeFlags`, `readFlags`, `writeFlagPattern?`, `writeFlagsConsumingValue?`, `readFlagsConsumingValue?`, `targetFromFlagValue?`, `targetFromUrlBasename?`, `default`.

Migration note: previously-inline `sed -i` / `awk -i inplace` checks are now table-driven entries; the awk special-case resolver (`resolveAwk`) retains only the GNU-specific `-i inplace` space-form and body-redirect scanning.

### Registered verbs (7)

| Verb   | writeFlags                                              | readFlags            | writeFlagsConsumingValue                          | readFlagsConsumingValue | targetFromFlagValue | targetFromUrlBasename | default |
| ------ | ------------------------------------------------------- | -------------------- | ------------------------------------------------- | ----------------------- | ------------------- | --------------------- | ------- |
| `sed`  | `-i`, `--in-place` + pattern `/^-i[A-Za-z.]*$/`         | --                   | --                                                | `-f`                    | --                  | --                    | read    |
| `awk`  | `-i`, `--in-place`                                      | --                   | --                                                | `-f`                    | --                  | --                    | read    |
| `sort` | `-o`                                                    | --                   | `-o`                                              | --                      | `-o`                | --                    | read    |
| `curl` | `-o`, `-O`                                              | --                   | `-o`, `-O`                                        | --                      | `-o`                | `-O`                  | read    |
| `wget` | `-O`                                                    | --                   | `-O`                                              | --                      | `-O`                | --                    | read    |
| `tar`  | `-cf`, `-xf`, `-cvf`, `-xvf`, `-czf`, `-xzf`, `-cJf`, `-xJf`, `-c`, `-x` | `-tf`, `-tvf`, `-t` | `-f`, `-cf`, `-xf`, `-cvf`, `-xvf`, `-czf`, `-xzf`, `-cJf`, `-xJf` | -- | same as writeFlagsConsumingValue | -- | read |
| `jq`   | `-i`, `--in-place`                                      | --                   | --                                                | --                      | --                  | --                    | read    |

Read-wins precedence (AC-ITEM-3.4): a read-flag literal match beats any co-occurring write flag.

`writeFlagPattern`: regex form for write flags (e.g., `sed -i.bak`, `sed -iSUFFIX`). Checked after literal-table miss.

`targetFromFlagValue`: the flag's value token is treated as the target basename source, normalized and matched against `PROTECTED_FILENAMES`. Example: `sort -o session.json` → write target `session.json`.

`targetFromUrlBasename`: the flag's value is parsed as a URL; the basename of the URL's path component is the target. Example: `curl -O https://host/path/session.json` → write target `session.json`. `curl -O https://host/` → no target (trailing slash).

---

## v2: Compound Short-Flag Expansion (§10.6a)

A compound short-flag token (e.g., `-abc`) is expanded character-by-character into individual flags (`[-a, -b, -c]`) when:

- Token starts with single `-` (not `--`) and is 3+ chars long.
- Token does **not** match the verb's `writeFlagPattern` (literal match wins — e.g., `sed -i.bak` matches `/^-i[A-Za-z.]*$/` and is **not** expanded).
- Token is **not** present in any declared flag list (literal match wins — e.g., tar's `-cf` is declared, not expanded).

### Classification rules for expanded chars

- **Write dominates read**: if any expanded char matches a write flag, the token classifies as write.
- **Unknown char → ambiguous (fail-closed)**: an expanded char not in any declared flag list (and not a recognized modifier) triggers `intent: 'ambiguous'`, `reason: 'ambiguous'`. This is fail-closed by design — unknown compound chars could hide arbitrary behavior.
- **Recognized tar modifiers** (`-j`, `-z`, `-J`, `-a`, `-v`, `-f`) are **non-classifying**: they neither force read nor write, and do not trigger unknown-char fail-closed. The classification comes from accompanying mode chars (`-c`, `-x`, `-t`).

### Examples

| Token     | Verb   | Expansion                    | Result                                |
| --------- | ------ | ---------------------------- | ------------------------------------- |
| `-xvzf`   | `tar`  | `[-x, -v, -z, -f]`           | write (`-x` extract)                  |
| `-tvf`    | `tar`  | literal match, no expansion  | read (declared `-tvf`)                |
| `-nf`     | `git clean` | handled at subcommand layer | variant `-n` → read (dry-run)         |
| `-i.bak`  | `sed`  | literal-match `writeFlagPattern` | write (no expansion)              |
| `-abc`    | `tar`  | `[-a, -b, -c]`               | `-a` modifier, `-b` unknown → ambiguous |

---

## v2: Env-Var Security Denylist (§10.5a)

New fail-closed guard: when an env-prefix assignment (`VAR=value`) appears at the start of a command, the VAR name is checked against a security denylist. A match triggers `intent: 'ambiguous'`, `reason: 'bypass_suspected'`. Iteration is **left-to-right** over contiguous leading env-prefix tokens; the check runs **after** the tightened env-prefix regex validation but **before** verb lookup.

### Denylist (27 effective entries)

**26 literal names** (Set membership):

```
LD_PRELOAD, LD_LIBRARY_PATH, BASH_ENV, ENV, IFS, PATH, PS4,
PYTHONPATH, NODE_OPTIONS, RUBYOPT, RUBYLIB, PERL5OPT, PERL5LIB,
LESSOPEN, LESSCLOSE, MANPAGER, PAGER,
GIT_SSH_COMMAND, GIT_PROXY_COMMAND, GIT_EXTERNAL_DIFF, GIT_PAGER,
SSH_AUTH_SOCK, PROMPT_COMMAND, SHELLOPTS, BASHOPTS, CDPATH
```

**1 prefix match**: any env-var name starting with `DYLD_` (Apple dynamic-linker family — `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `DYLD_FRAMEWORK_PATH`, etc.).

### Allowed (explicitly NOT on denylist)

Legitimate git scoping env-vars are permitted and do **not** trigger the denylist:

```
GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_* (any GIT_CONFIG_ prefix)
```

Rationale: these variables scope git operations but cannot smuggle arbitrary code execution into the classified verb. They are common in sandbox-style invocations and are NOT a known bypass vector.

### Example

| Command                                           | Result                              |
| ------------------------------------------------- | ----------------------------------- |
| `LD_PRELOAD=/tmp/evil.so ls`                      | ambiguous (`bypass_suspected`)      |
| `PATH=/tmp:/bin cat session.json`                 | ambiguous (`bypass_suspected`)      |
| `DYLD_INSERT_LIBRARIES=/tmp/x.dylib git status`   | ambiguous (`bypass_suspected`)      |
| `GIT_DIR=.git git status`                         | read (allowed)                      |
| `FOO=bar ls session.json`                         | read (env stripped, ls in READ_VERBS) |

---

## v2: INV-6 Substitution Triggers (Expanded)

The INV-6 guard extends the substitution fail-closed scan from redirect targets to every token (word, redirect, heredoc-body). Two-tier design: Tier A unconditional, Tier B conditional on embedding context. INV-6 runs at depth 0 (top-level), before segment classification. Recursive calls from substitution bodies do not re-run INV-6 (body is already a stripped sub-command).

### Trigger list

Any of the following markers in any token fire INV-6:

| Trigger               | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `$(`                  | Command substitution                           |
| `` ` ``               | Backtick command substitution                  |
| `<(`                  | Process substitution (input)                   |
| `>(`                  | Process substitution (output)                  |
| `${!`                 | Indirect variable expansion (bash-specific)    |
| `$((var=expr))`       | Arithmetic assignment                          |
| `$((var<op>=expr))`   | Arithmetic compound assign (`+=`, `-=`, `*=`, `/=`, `%=`, `<<=`, `>>=`, `&=`, `|=`, `^=`) |
| `$((var++))`          | Arithmetic post-increment                      |
| `$((var--))`          | Arithmetic post-decrement                      |

### Tier A (unconditional)

Indirect expansion (`${!...}`) and arithmetic assign/inc/dec (`$((...=))`, `$((...++))`, `$((...--))`). These **always** fail closed when present in any token, regardless of embedding context. They mutate shell environment / variables outside the substitution-body classify path and have no legacy depth-1 recursion handling.

### Tier B (conditional)

Command substitution and process substitution (`$(`, backtick, `<(`, `>(`). Fire fail-closed only when the trigger appears:

- **Embedded** inside a flag-looking token (starts with `-`). Example: `--porcelain=$(evil)` → fail-closed.
- **Embedded** inside a larger word (not as the whole token). Example: `prefix$(evil)suffix` → fail-closed.

**Bare** substitution forms (the entire unquoted token body IS the substitution) still go through the existing FR-011 depth-1 recursion path. Example: `echo $(cat foo)` → bare substitution, recurse body `cat foo`, classify as read.

### INV-6 overrides ITEM-5.2

INV-6 triggers inside a `-m` body still fire, even though non-ASCII content is otherwise exempt. Example: `git commit -m "feat: $(whoami) ship"` → fail-closed with `bypass_suspected` (the `$(` trigger overrides the body exemption).

---

## v2: UTF-8 `-m` Body Exemption (ITEM-5.2)

Scoped exemption from the non-ASCII fail-closed rule (INV-4) for commit/tag/notes/stash message bodies. Preserves the SEC-001 baseline (no observable block regression) while allowing UTF-8 in legitimate message text.

### Scope

- Verbs: `git commit`, `git tag`, `git notes`, `git stash`.
- Flags: `-m <body>`, `--message <body>`, `--message=<body>`.
- Body length: < 64 KB (bodies at or above 64 KB hit the global `length_exceeded` guard first).

### Exemption behavior

- Non-ASCII bytes inside the body are **allowed** (do not trigger the INV-4 non-ASCII fail-closed rule).
- The body is **not scanned** as a positional target (so `git commit -m "fix session.json"` does not match `session.json` as a write target — body is opaque per AC-ITEM-5.1).
- All **other tokens** (command name, flags, other values) still fail-closed on non-ASCII.
- The body is **NOT exempt from INV-6**: any of the 9 substitution triggers inside the body still fail-closed (see previous section).

### Example

| Command                                                 | Result                          |
| ------------------------------------------------------- | ------------------------------- |
| `git commit -m "fix: 日本語 handling"`                  | write (allowed — UTF-8 in body) |
| `git commit -m "fix session.json path"`                 | write (body not scanned)        |
| `git commit -m "feat: $(evil) ship"`                    | ambiguous (`bypass_suspected` — INV-6 overrides) |
| `git 日本語 commit -m "x"`                              | ambiguous (non-ASCII outside body) |

---

## v2: Reserved-Name Guard on registerVerb

`registerVerb(verb, flagTable)` rejects any `verb` whose lowercase basename is a member of `BASH_WRITE_VERBS`. Prevents an attacker (or misconfigured downstream module) from shadow-registering a write verb with a `default: 'read'` flag table, which would be picked up by the `VERB_FLAG_TABLE` lookup before the `BASH_WRITE_VERBS` check and silently reclassify writes as reads.

### Guarded verb names (14)

```
cp, mv, rm, tee, ln, install, mkdir, rmdir,
chmod, chown, touch, truncate
```

(Plus `dd`, `rsync`, `unlink` -- full `BASH_WRITE_VERBS` set in the library source.)

### Error shape

```
Error: registerVerb: 'cp' is a reserved write-verb (in BASH_WRITE_VERBS). Reserved verbs cannot be registered with custom flag tables.
```

Thrown synchronously at registration time. The idempotent-if-identical policy does **not** apply to reserved-name rejections — a reserved-name registration is **always** rejected, even if structurally identical to a (nonexistent) prior entry.

---

## Path Normalization (8 Steps)

Applied to every protected-target candidate before comparison. Order is load-bearing; do not reorder:

1. **Quote strip** -- remove surrounding single, double, or ANSI-C (`$'...'`) quotes.
2. **ANSI-C decode** -- for `$'...'` only, decode `\n`, `\t`, `\'`, `\"`, `\\`, `\0`.
3. **Non-ASCII raw-byte scan** (before NFC) -- any byte > 0x7F fails closed with `bypass_suspected`. Load-bearing for SEC-003 homoglyph defense: unicode-lookalikes (e.g., U+2024 one-dot leader) must be rejected before NFC flattens them.
4. **NFC normalization** -- ASCII-safe no-op in practice; present for conformance.
5. **Path-separator normalization** -- collapse `\` to `/`, dedupe consecutive `/`, strip trailing `/`.
6. **Basename extraction** -- everything after the last `/`.
7. **Platform-adaptive case policy** -- `darwin` -> case-insensitive (APFS default); `linux` -> case-sensitive; other -> case-insensitive fallback.
8. **Compare** against `PROTECTED_FILENAMES` (exact) and `PROTECTED_FILENAME_PATTERNS` (regex) at the caller.

Additional fail-closed triggers interleaved between steps:

- Percent-encoded character (`%XX`) -> `bypass_suspected`.
- Glob metachar (`*`, `?`, `[`, `]`, `{`, `}`) -> `bypass_suspected`.
- Command substitution in path (`$(...)`, backtick) -> `ambiguous`.
- Variable reference in path (`$VAR`, `${VAR}`) -> `ambiguous`.

Tilde (`~`, `~user`) is treated as a literal character. `$HOME` is never expanded by the classifier (SEC-009).

---

## Fail-Closed Policy

Any condition the classifier cannot statically resolve returns `intent: 'ambiguous'` with a typed `reason`. The hook blocks with exit code 2 and emits one synchronous stderr line before exit:

```
HOOK_CLASSIFIER_FAIL_CLOSED: reason=<reason> verb=<verb> length=<N>
```

Emitted via `fs.writeSync(2, ...)` to guarantee the line flushes before `process.exit(2)` -- buffered `console.error` would be lost (NFR-004).

| `reason`           | Triggered by                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parse_failure`    | Unterminated quote, unbalanced group, malformed heredoc delimiter.                                                                                                                                                                                                             |
| `length_exceeded`  | Command byte length > 65 536.                                                                                                                                                                                                                                                  |
| `bypass_suspected` | Non-ASCII raw byte, percent-encoded character, glob in a path token, env-var denylist match (§10.5a), or INV-6 substitution trigger (Tier A / embedded Tier B).                                                                                                                |
| `ambiguous`        | Recursion depth > 2, dynamic-body construct (`eval`, `new Function`, `__import__`), unrecognized inline runner referencing a protected basename, unknown git subcommand, variable-path target, command substitution in a redirect target, `env -i`, `xargs`, `find`, `coproc`, unknown compound short-flag char. |

`verb` is a best-effort first-token label extracted by `extractFirstVerbForTelemetry` in the hook; returns `'unknown'` on failure. `length` is the UTF-8 byte length of the command.

---

## Mixed Exact + Pattern PPID Denial (Security Invariant)

The hook grants a PPID-attested exemption to the dedicated audit-append CLI (`node .claude/scripts/audit-append.mjs`) so it can write to pattern-matched audit logs (`kill-switch.log.N.jsonl`, `rate-limit.state`). The exemption applies only when **every** target in the classifier result is a pattern match:

```javascript
const allPattern =
  classification.targets.length > 0 &&
  classification.targets.every((t) => t.matchType === 'pattern');
if (allPattern && auditAppendAuthorized()) {
  process.exit(0);
}
```

If the target array mixes exact and pattern matches (for example, a single command that touches both `session.json` and `kill-switch.log.jsonl`), the exemption is denied for the entire command regardless of PPID attestation. This closes a dogfooding-style bypass where an attestation-eligible process would otherwise ride the exemption to write an exact-name protected file.

The exemption itself uses process-ancestor attestation:

- Require parent-process `argv[0]` basename to be `node` (or `.node`).
- Require `argv[1]` basename to be `audit-append.mjs` with no earlier path component literally named `audit-append.mjs` (defeats `node /tmp/audit-append.mjs/wrapper.sh` wrapper-directory bypass).
- Platform readers: `/proc/<ppid>/cmdline` on Linux (NUL-separated argv); `ps -o args= -p <ppid>` on macOS (whitespace-separated, only `argv[0..1]` consumed).
- Any read failure, fewer than two tokens, or anchor-shape mismatch -> attestation returns `false` (fail-closed).

---

## Tokenizer Coverage

- **Quoting**: single, double, ANSI-C (`$'...'`). Escape handling inside double quotes preserves `\\` and `\"`.
- **Heredocs**: eight delimiter forms -- `<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`, `<<-EOF`, `<<-'EOF'`, `<<-"EOF"`, `<<-\EOF`. Body is captured as a `heredoc-body` token; trailing tokens on the `<<EOF` line (like `> target`) are still parsed.
- **Substitution**: `$(...)`, backtick, `$((...))` arithmetic, `<(...)` / `>(...)` process substitution. Depth > 1 inside `$(...)` fails closed.
- **Redirects**: `>`, `>>`, `2>`, `2>>`, `&>`, `&>>`, `>|`, `<>`, plus `N>`, `N>>`, `N<`, `N<>` (file-descriptor-numbered), plus `N>&M`, `<&M` (fd-duplication -- consumed as no-op).
- **Chains**: `;`, `&&`, `||`, `|`, `|&`, `&`, and multi-char variants (`;;`, `;&`, `;;&`).
- **Groups**: `( ... )`, `{ ... }`. Unbalanced -> `parse_failure`.
- **Comments**: `#` to end of line, only at token-start positions.

---

## Language Coverage for Inline-Script Bodies

Per-language write-syscall catalogs (`WRITE_SYSCALL_PATTERNS`) are applied to the `-e` / `-c` / `eval` body of recognized inline runners:

| Verb                    | Catalog                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node`, `nodejs`, `bun` | `writeFileSync`, `writeFile`, `appendFileSync`, `appendFile`, `createWriteStream`, `writev`, `fs.write`, `fs.writeSync`, `open` / `openSync` with `'w'`/`'a'`/`'x'` mode, `truncate`, `rename`, `copyFile`, `unlink`, `rmSync`, `fs.rm`, `process.binding('fs')`, plus Bun's `Bun.write`, `Bun.file(...).writer`. |
| `python`, `python3`     | `open(path, 'w\|a\|x')`, `io.open`, `codecs.open`, `Path(...).write_text` / `write_bytes` / `open(...)` with write mode, `os.remove`, `os.unlink`, `os.rename`, `shutil.copy*`, `shutil.move`.                                                                                                                    |
| `perl`                  | `open(FH, '>path')`, `sysopen ... O_WRONLY\|O_CREAT\|O_TRUNC\|O_APPEND`, `unlink`, `rename`.                                                                                                                                                                                                                      |
| `ruby`                  | `File.write`, `File.open` / `File.new` with `'w'`/`'a'`/`'r+'` mode, `IO.write`, `FileUtils.{cp,mv,rm,ln}`, `File.delete`, `File.unlink`.                                                                                                                                                                         |
| `deno`                  | `Deno.writeFile*`, `Deno.writeTextFile*`, `Deno.create*`, `Deno.open` with `{ write: true }` option, `Deno.remove*`, `Deno.rename*`, `Deno.copyFile*`.                                                                                                                                                            |
| `sh`, `bash`            | Recursively re-classified as a shell command (depth +1).                                                                                                                                                                                                                                                          |

Unrecognized inline runners (`php`, `lua`, `R`, `tcl`) fail closed with `ambiguous` if the body contains any protected basename substring.

Dynamic-bypass constructs (`eval(`, `new Function(`, `AsyncFunction`, `GeneratorFunction`, `Reflect.apply`, computed property access on `require('fs')`, `__import__`, template-literal method access with interpolation) always fail closed with `ambiguous` regardless of the body's other content.

---

## Prefix-Strip Policy

Prefix verbs are classified into three tiers before verb resolution (`stripPrefixes`):

| Tier        | Behavior                                                     | Members                                                                               |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| STRIP       | Prefix consumed; verb resolution proceeds on the next token. | `sudo`, `nohup`, `timeout`, `stdbuf`, `nice`, `ionice`, `time`, `command`, `builtin`. |
| FAIL-CLOSED | Dynamic body cannot be statically analyzed -> `ambiguous`.   | `eval`, `env -i`.                                                                     |
| AMBIGUOUS   | Uncertain recursion or dispatch model -> `ambiguous`.        | `xargs`, `find`, `coproc`.                                                            |

`env VAR=value` assignments (no `-i`) are skipped; the next non-assignment token is the verb. v2: the tightened env-prefix regex (`^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.:/\\@+-]*$`) replaces the prior permissive form, and the §10.5a denylist check fires on each leading assignment before stripping (left-to-right).

---

## Known Tradeoffs

- Path normalization refuses any path containing `$VAR` or `$(...)`. Commands that dynamically construct a protected target path (for example `node -e "require('fs').writeFileSync(process.env.X, ...)"`) cannot be proven safe by static analysis and are blocked as `bypass_suspected` (SEC-005). This is the intended behavior -- the hook chooses availability loss over confidentiality loss.
- macOS `ps -o args=` for PPID attestation collapses whitespace between `argv` tokens. Paths with spaces in `argv[1]` cannot be recovered and fail closed. Acceptable per SEC-010 (audit integrity > availability).
- The 64 KB command-length guard refuses genuinely long (but legitimate) here-document commands. Operators who need to emit larger payloads via Bash must break them across multiple invocations or use a dedicated CLI.
- Linux-but-WSL detection is best-effort. WSL exposes `platform() === 'linux'` but mounts NTFS case-insensitive. Operators on WSL who hit case-related bypass issues can raise a ticket for a future env-override knob.

---

## Configuration

The classifier is fully self-contained. No environment variables, no configuration files, no external dependencies. The protected-file list is imported from `workflow-file-protection.mjs` (single source of truth). Updating the protected set requires editing `PROTECTED_FILENAMES` / `PROTECTED_FILENAME_PATTERNS` in the hook module; the classifier re-exports whichever values the hook exposes at import time.

---

## Test Coverage

The classifier is covered by five test suites in `.claude/scripts/__tests__/`:

| Suite                                        | Focus                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `bash-intent-classifier.contract.test.mjs`   | Public API shape: return structure, target source enum, reason enum, export surface.     |
| `bash-intent-classifier.positive.test.mjs`   | Writes that must block: tee, redirect, inline-script writeFileSync, `sed -i`, etc.       |
| `bash-intent-classifier.negative.test.mjs`   | Reads that must not block: cat / jq / grep piping, commit messages, documentation edits. |
| `bash-intent-classifier.live-repro.test.mjs` | Live-session repros (including `cat session.json \| node -e "readFileSync(0)"`).         |
| `bash-intent-classifier-fuzz.test.mjs`       | Random-ish input fuzzer -- no uncaught exceptions, all results shape-valid.              |

Performance and synchronous-emission integration tests live in `.claude/scripts/__tests__/perf/`.

Total: 356 tests across the classifier and its hook integration. The SEC-001 baseline matrix (35 assertions on the pre-refactor protected-file behavior) is preserved byte-identical.

---

## See Also

- [`bash-intent-classifier-api.md`](./bash-intent-classifier-api.md) -- library API reference.
- [`WORKFLOW-ENFORCEMENT.md`](./WORKFLOW-ENFORCEMENT.md) § Protected File Write Detection.
- [`HOOKS.md`](./HOOKS.md) § PreToolUse Hooks (Write / Bash - Enforcement File Protection).
