---
title: smart-file-query Agent Script Design
status: draft
owners:
  - agents
created: 2025-10-24
---

## Overview

`smart-file-query` condenses repo exploration into a single command that searches, scopes, and inspects files. It accepts a JavaScript regular expression plus an optional glob slice, gathers match locations with surrounding context, and optionally emits the complete file bodies for follow-up review. The script returns minified JSON so downstream tooling (other agents, IDE tasks) can consume results without additional parsing steps.

## Goals

- Provide a single CLI (`node agents/scripts/smart-file-query.mjs`) that replaces the common loop of `rg --context`, `ls`, and ad-hoc file reads.
- Support regex search across one or many files, scoping candidates with repo-relative glob patterns (e.g., `packages/**/schemas/**/*.ts`).
- Emit line matches with surrounding context lines and an opt-in full-content payload for matched files.
- Enforce safety rails (file size caps, binary detection, match limits) so the command remains responsive in large repos.
- Produce stable, minified JSON on stdout for automation; route diagnostics and errors to stderr.

## Non-goals

- Replacing every search primitive (e.g., structural AST queries, git history inspection).
- Managing long-running search daemons or watch mode.
- Streaming incremental output; the script materializes the full payload before printing.

## CLI Contract

Run from the repository root (`process.cwd()` assumed to be project root).

```
node agents/scripts/smart-file-query.mjs --regex "<pattern>" [options]
```

| Flag                       | Required | Default   | Description                                                                                                       |
| -------------------------- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `--regex <pattern>`        | ✅       | –         | JavaScript regex pattern (no surrounding slashes). Passed directly to `new RegExp(pattern, flags)`.               |
| `--flags <value>`          | ❌       | `""`      | Optional regex flags (`i`, `m`, `u`, etc.). Validated to avoid duplicates/unsupported letters.                    |
| `--glob <pattern>`         | ❌       | `**/*`    | Repo-relative glob limiting candidate files. Accepts `*`, `?`, `**`, `{a,b}`. Multiple globs separated by commas. |
| `--ignore <pattern>`       | ❌       | `.git/**` | Comma-separated globs to exclude (defaults to `.git`, `node_modules`, `.turbo`).                                  |
| `--contextLines <number>`  | ❌       | `2`       | Number of surrounding lines to include before/after each match (0–20).                                            |
| `--includeAllContent`      | ❌       | `false`   | When present, embed the full file contents for every file with at least one match (subject to size limits).       |
| `--maxFileSizeKB <number>` | ❌       | `256`     | Skip files larger than this size (in kilobytes). Applies both to initial scan and `includeAllContent`.            |
| `--maxMatches <number>`    | ❌       | `500`     | Hard cap on total matches returned. When exceeded, truncate output and set `truncated: true` flags.               |
| `--encoding <value>`       | ❌       | `utf8`    | File encoding for reads. Reject unsupported encodings.                                                            |
| `--help`                   | ❌       | –         | Print usage and exit.                                                                                             |

### CLI Parsing Notes

- Use `process.argv.slice(2)` with a lightweight manual parser (mirroring `load-context.mjs`) while supporting `--flag=value` and `--flag value`.
- Validate that numeric flags are finite integers within bounds; exit with code `1` and an explanatory stderr message if validation fails.
- Ensure regex pattern survives shell quoting: treat the value as raw text, not JSON, and leave escaping to the shell (documented in the usage banner).
- Allow multiple `--glob`/`--ignore` entries via comma splitting and trimming whitespace.

## High-level Flow

1. **Parse & validate options**. Construct a `RegExp` instance early to fail-fast on invalid syntax or flags.
2. **Collect candidate files**.
   - Start from `process.cwd()`.
   - Prefer a fast file-listing strategy using `git ls-files` (via `execSync`, already used in `agents/scripts/utils.mjs`) to stay aligned with tracked content. Fall back to on-disk traversal when `git` is missing (log warning and traverse via `fs.promises.readdir`).
   - Apply include globs and ignore globs to the candidate list.
3. **Filter by size & encoding**.
   - `fs.stat` (or `Dirent` metadata) to reject files over `maxFileSizeKB`.
   - Skip binary files (detect by scanning the first 1 KB for null bytes) with a `reason: 'binary'` entry in `skipped`.
4. **Search file contents**.
   - Read file once, split into lines (`split(/\r?\n/)`) while retaining original line endings for optional full content.
   - Use `regex.exec` in a loop with `lastIndex` to gather all matches; guard against zero-length matches by manually advancing `lastIndex` to avoid infinite loops.
   - For each match, capture:
     - `lineNumber` (1-based),
     - `column` (1-based, counting code points to handle multibyte characters consistently with JS strings),
     - `match` (the exact substring),
     - `context.before` / `context.after`: arrays of up to `contextLines` strings,
     - `context.line`: the entire matched line.
5. **Assemble file payload**.
   - Include `path`, `size` (bytes), `matches`, optional `content`, and `truncated` flags.
   - When `includeAllContent` is enabled but the file exceeds `maxFileSizeKB`, omit `content` and annotate the file within `skipped` with `reason: 'maxFileSizeExceeded'`.
6. **Construct response JSON**.
   - Root object:
     ```json
     {
       "query": {
         "regex": "<pattern>",
         "flags": "<flags>",
         "glob": ["..."],
         "ignore": ["..."],
         "contextLines": 3,
         "includeAllContent": true,
         "maxFileSizeKB": 256,
         "maxMatches": 500
       },
       "results": [
         {
           "path": "packages/.../file.ts",
           "size": 1234,
           "matchCount": 2,
           "matches": [
             {
               "lineNumber": 14,
               "column": 5,
               "match": "TrackingSync",
               "context": {
                 "before": ["..."],
                 "line": "...",
                 "after": ["..."]
               }
             }
           ],
           "content": "...", // optional
           "truncated": false // true when maxMatches limit truncates per-file matches
         }
       ],
       "skipped": [
         {
           "path": "packages/.../large.ts",
           "reason": "maxFileSizeExceeded",
           "size": 1048576
         },
         { "path": "packages/.../binary.dat", "reason": "binary" }
       ],
       "aggregate": {
         "filesVisited": 42,
         "filesMatched": 3,
         "totalMatches": 9,
         "truncated": false
       }
     }
     ```
   - Serialize with `JSON.stringify(payload)` (minified) and write once to `stdout`.
   - Route warnings to `stderr` (e.g., `⚠️  Skipped 3 files over size limit`). Avoid mixing logs into stdout.

## Glob Matching Strategy

- Use `picomatch` (new dependency) for reliable `{a,b}`, `**`, and ignore semantics. Rationale:
  - The repo already relies on Node-based tooling; `picomatch` offers minimal footprint (~20 KB) and no native builds.
  - Re-implementing globbing is error-prone (especially with `**` and braces), and `minimatch` is slower on large file sets.
- Implementation detail:
  - Lazily import `picomatch` (`const picomatch = await import('picomatch');`) so the script loads quickly when just showing `--help`.
  - Compile include and ignore matchers once, then filter candidate paths: include when any include matcher passes and all ignore matchers fail.
- Document in the design risk section that introducing `picomatch` requires adding it to the repo root `package.json` devDependencies; highlight the tiny footprint and long-term maintenance considerations.

## Safety Rails & Edge Cases

- **Large files**: skip ahead of read; surfaced in `skipped` array and stderr warning summary.
- **Binary detection**: scan first chunk for ASCII control characters (`< 32` excluding tab/newline/carriage return) or `0x00`. Flag as `binary`.
- **Regex pitfalls**: guard zero-length matches by detecting if `match.index === regex.lastIndex`; if so, increment `regex.lastIndex += 1`.
- **Match cap**: track global match count. Once `totalMatches === maxMatches`, stop processing remaining files, set `aggregate.truncated = true`, and note per-file `truncated = true` when local matches were cut off.
- **UTF-16 surrogate pairs**: columns computed via `Array.from(line.slice(0, matchColumn)).length + 1` to avoid undercounting.
- **Error handling**:
  - Invalid options => print message + usage to stderr, exit `1`.
  - Unexpected IO error => emit message referencing file path, include `error.code`, exit `1`.
  - For partial failures (e.g., file read fails after listing), push entry into `skipped` with `reason: 'readError'`.

## Implementation Outline

1. **Bootstrap CLI**: usage banner, option parser, validation helpers.
2. **File discovery utilities**:
   - Extract `listGitTrackedFiles` from `agents/scripts/utils.mjs`.
   - Add fallback `walkDir(root, ignoreMatchers)` for non-git environments.
3. **Glob matcher harness**:
   - Add helper `buildGlobMatcher(patterns)` returning predicate.
   - Normalize windows paths to POSIX (`replace(/\\/g, '/')`).
4. **Search engine**:
   - `searchFile({ path, regex, contextLines, includeContent, sizeLimit })` that returns `matches`, optional `content`, `truncated`.
   - Provide deterministic sorting by repo-relative path (`results.sort((a, b) => a.path.localeCompare(b.path))`).
5. **Output assembly**: aggregate stats, truncated flags, and `skipped` reasons.
6. **CLI integration**: wire everything inside an async `main()` with top-level `await` guard and `process.exit` on fatal errors.

## Testing Strategy

Tests will live alongside the script in a future change (`agents/scripts/__tests__/smart-file-query.test.ts`) and follow `agents/memory-bank/testing.guidelines.md`. Proposed coverage:

- Happy path: single file match, assert JSON shape, context lines, and minified output.
- Glob filtering: include/exclude interplay, Windows path normalization.
- Size cap + binary skip: verify `skipped` array and stderr summary.
- Regex edge cases: zero-length matches, multi-match per line.
- `--includeAllContent`: confirm large files omitted, content present otherwise.

During build phase implementation, run `npm run phase:check` to keep linting and code-quality automation satisfied. Verify phase will include `node agents/scripts/git-diff-with-lines.mjs` output capture and `npm run agent:finalize`.

## Risks & Mitigations

- **Dependency bloat**: adding `picomatch` introduces maintenance overhead. Mitigation: justify in PR, lock version, and mention in `agents/tools.md`.
- **Large payloads**: enabling `--includeAllContent` on many files may produce huge JSON. Mitigation: enforce match/file caps and document best practices (e.g., narrow glob first).
- **Regex performance**: catastrophic backtracking on poorly chosen patterns can stall the script. Mitigation: document caution in usage banner and prefer anchored patterns when possible.
- **Cross-platform path consistency**: rely on POSIX-style internal paths to keep output deterministic across macOS/Linux/Windows.

## Follow-ups

- Update `agents/tools.md` to list the new script and summarize its flags (separate change).
- Consider optional `--jsonLines` output mode if future agent workflows prefer streaming.
- Explore integration with Memory Bank retrieval (e.g., preloading recent schema directories) once adoption patterns are clear.
