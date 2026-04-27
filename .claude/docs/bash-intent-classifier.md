---
_source_modules: ['scripts-lib', 'workflow-scripts']
last_reviewed: 2026-04-27
title: Bash Intent Classifier - Architecture
---

# Bash Intent Classifier - Architecture

Runtime contract for `.claude/scripts/lib/bash-intent-classifier.mjs`, used by
`.claude/scripts/workflow-file-protection.mjs` to decide whether a Bash command
may write protected enforcement files. API details are in
[`bash-intent-classifier-api.md`](./bash-intent-classifier-api.md).

## Purpose

The classifier replaces raw substring matching with argument-position-aware Bash
classification. It should allow ordinary reads and text mentions of protected
filenames while blocking credible writes to targets such as `session.json`,
kill-switch files, deployment intervention logs, and protected state patterns
declared by `workflow-file-protection.mjs`.

## Decision Contract

The library returns `{ intent, targets, reason? }`.

| Intent | Hook behavior | Meaning |
| --- | --- | --- |
| `read` | Allow | No protected target appears in a write context. |
| `write` | Block unless PPID exemption applies | Protected target was found in a write context. |
| `ambiguous` | Block | Static analysis could not prove safety. |

Write targets include:

- Protected basename as redirect target.
- Protected basename as positional target to write verbs such as `tee`, `cp`,
  `mv`, `rm`, `dd`, `rsync`, `install`, `ln`, `chmod`, `chown`, `touch`,
  `truncate`, `mkdir`, and `unlink`.
- Protected basename produced from flag values such as `sort -o FILE`,
  `tar -cf FILE`, `curl -O URL`, or `wget -O FILE`.
- Protected literal path inside recognized inline-runner write syscalls.
- Protected target reached through safe recursive substitution parsing.

## Pipeline

1. Reject commands over `MAX_COMMAND_BYTES`.
2. Tokenize into words, redirects, chains, heredoc bodies, and groups.
3. Run top-level substitution and bypass scans.
4. Split command segments on `;`, `&&`, `||`, `|`, `|&`, and `&`.
5. Inspect redirect targets.
6. Recurse into command-substitution bodies where static parsing is safe.
7. Strip safe prefixes and env assignments.
8. Resolve verb, git subcommand, and global git flags.
9. Apply declarative per-verb flag tables.
10. Combine segment verdicts: any write wins; otherwise any ambiguous wins;
    otherwise read.

The order is part of the contract. The substitution/bypass scan runs before
verb classification; env-prefix denylist checks run before verb lookup.

## Tokenizer Coverage

The tokenizer supports:

- Single, double, and ANSI-C quotes.
- Heredocs including quoted, escaped, and tab-stripped delimiters.
- Command, backtick, arithmetic, input process, and output process
  substitution.
- Redirects including `>`, `>>`, `2>`, `2>>`, `&>`, `&>>`, `>|`, `<>`, and
  file-descriptor forms.
- Chain operators and command groups.
- Token-boundary comments.

Parse failures return `ambiguous` with `reason: 'parse_failure'`.

## Path Normalization

Protected-target candidates pass through this fixed normalization sequence:

1. Strip surrounding ASCII quotes.
2. Decode ANSI-C escapes for `$'...'`.
3. Reject non-ASCII raw bytes before NFC normalization.
4. Apply NFC normalization.
5. Normalize path separators.
6. Extract basename.
7. Apply platform case policy.
8. Compare against `PROTECTED_FILENAMES` and `PROTECTED_FILENAME_PATTERNS`.

Percent encoding and glob metacharacters fail closed as `bypass_suspected`.
Variable paths and command substitution in paths fail closed as `ambiguous`.
Tilde and `$HOME` are not expanded.

## Git Classification

`git` is subcommand-aware rather than a flat read verb.

Read variants include:

- `worktree list|prune|repair`
- `stash list|show`
- `remote show|-v|get-url`
- `tag -l|--list`
- `config --get|-l|--list`
- wildcard read for `rev-parse`, `describe`, `rev-list`, `reflog`, and `fsck`
- `clean -n|--dry-run`
- `bisect log|view|visualize|help`

Write-to-non-protected variants include:

- `worktree add|remove|move`
- `stash push|pop|drop`
- `remote add|remove`
- `clean -i` and wildcard fallback
- wildcard write for `tag` and `gc`
- `bisect start|good|bad|skip|reset|run|old|new|replay|terms`

Bare defaults: `git stash` is write-to-non-protected; `git tag`,
`git config`, and `git bisect` are read. Global flags stripped before
subcommand resolution include `-C`, `--git-dir`, `--work-tree`, `-c`,
`--no-pager`, and `--no-optional-locks`.

## Flag-Aware Verbs

Declarative flag tables cover `sed`, `awk`, `sort`, `curl`, `wget`, `tar`, and
`jq`.

Rules:

- Read flags beat write flags when both appear.
- Write flags with values can turn the value into a protected-target
  candidate.
- `curl -O` derives the target from the URL basename.
- Compound short flags are expanded when no literal flag or regex pattern
  matches.
- Unknown compound flag characters fail closed.
- Tar mode modifiers such as `-v`, `-z`, `-J`, `-a`, and `-f` do not classify
  alone; mode flags such as create/extract/list decide.

## Prefix And Env Policy

Safe prefixes are stripped before verb resolution: `sudo`, `nohup`, `timeout`,
`stdbuf`, `nice`, `ionice`, `time`, `command`, and `builtin`.

Fail-closed prefixes and dispatch models:

- `eval` and `env -i` return `ambiguous`.
- `xargs`, `find`, and `coproc` return `ambiguous`.
- Leading env assignments are stripped only after the variable name passes the
  denylist.

Denied env names include dynamic-loader, shell-startup, path/search, pager,
git-hook, and proxy/diff variables such as `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `BASH_ENV`, `ENV`, `IFS`, `PATH`, `PS4`, `PYTHONPATH`,
`NODE_OPTIONS`, `RUBYOPT`, `PERL5OPT`, `LESSOPEN`, `PAGER`,
`GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `SSH_AUTH_SOCK`,
`PROMPT_COMMAND`, `SHELLOPTS`, `BASHOPTS`, `CDPATH`, and any `DYLD_*` name.

Allowed git scoping env names: `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_CONFIG_*`.

## Substitution And Message Bodies

Top-level substitution scanning catches embedded command/process substitution,
indirect expansion, and arithmetic mutation forms. Bare substitution tokens can
be recursively classified; embedded substitution inside a larger word or flag
fails closed.

UTF-8 is allowed inside `git commit`, `git tag`, `git notes`, and `git stash`
message bodies introduced by `-m`, `--message`, or `--message=<body>`. Those
bodies are not scanned as positional protected targets. Substitution triggers
inside message bodies still fail closed.

## Inline Runners

Recognized inline runners: `node`, `python`, `python3`, `perl`, `ruby`, `deno`,
`bun`, `sh`, and `bash`.

- `sh` and `bash` bodies recurse through the shell classifier.
- Other recognized runners use per-language write-syscall patterns.
- Dynamic constructs such as `eval`, `new Function`, computed filesystem
  method access, `Reflect.apply`, and Python `__import__` fail closed.
- Unrecognized runners fail closed when the body mentions a protected basename.

## Audit-Append Exemption

The hook has a narrow PPID-attested exemption for `audit-append.mjs` so the
dedicated audit writer can touch protected pattern targets.

The exemption is allowed only when every classified target is a pattern match.
A command that mixes exact and pattern targets is denied even if the parent
process attestation succeeds.

Attestation checks the parent process command line for `node` running
`audit-append.mjs`; unreadable or malformed parent state fails closed.

## Known Limits

- Dynamic target paths such as `$TARGET`, `${TARGET}`, or `$(...)` are blocked.
- Very long legitimate heredoc commands hit the byte-length guard.
- macOS parent-process inspection via `ps` cannot recover paths with spaces
  reliably and fails closed.
- WSL case sensitivity follows Node's reported platform and may not match every
  mounted filesystem.

## Configuration

There is no external config. The protected-file set lives in
`workflow-file-protection.mjs` and is re-exported by the classifier.

## Tests

Classifier and hook coverage lives under `.claude/scripts/__tests__/`:

- `bash-intent-classifier.contract.test.mjs`
- `bash-intent-classifier.positive.test.mjs`
- `bash-intent-classifier.negative.test.mjs`
- `bash-intent-classifier.live-repro.test.mjs`
- `bash-intent-classifier-fuzz.test.mjs`
- `bash-intent-classifier.registration.test.mjs`
- `perf/workflow-file-protection.perf.test.mjs`

## See Also

- [`bash-intent-classifier-api.md`](./bash-intent-classifier-api.md) - API reference.
- [`WORKFLOW-ENFORCEMENT.md`](./WORKFLOW-ENFORCEMENT.md) - enforcement context.
- [`HOOKS.md`](./HOOKS.md) - PreToolUse hook placement.
