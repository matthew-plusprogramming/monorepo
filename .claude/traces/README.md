# Trace Files

This directory stores trace configuration and generated trace summaries for the
`.claude` script surface.

Authoritative operator docs live in [`../docs/TRACES.md`](../docs/TRACES.md).
Keep this file short so agents can identify which files are committed and which
files are local generated cache.

## Tracked Files

| File | Purpose |
| --- | --- |
| `trace.config.json` | Module definitions and file globs. |
| `high-level.json` | Committed module dependency summary. |
| `high-level.md` | Human-readable view of `high-level.json`. |
| `README.md` | This landing page. |

## Local Generated Files

These files are regenerated locally and ignored by git:

| Path | Purpose |
| --- | --- |
| `staleness.json` | Incremental-generation cache. |
| `low-level/*.json` | Per-module file/import/export trace data. |
| `low-level/*.summary.json` | Compact per-module generated summaries. |
| `low-level/*.calls.json` | Call-graph sidecars. Do not read directly; use `trace-query.mjs`. |
| `low-level/*.md` | Generated human-readable per-module views. |

## Commands

```bash
node .claude/scripts/trace-generate.mjs
node .claude/scripts/trace-generate.mjs --full
node .claude/scripts/trace-generate.mjs <module-id>
node .claude/scripts/trace-query.mjs --module <module-id>
node .claude/scripts/trace-query.mjs --impact <file-path>
node .claude/scripts/trace-query.mjs --calls <functionName>
node .claude/scripts/trace-sync.mjs --dry-run
```

## Agent Use

- Read `high-level.md` for optional orientation before routing or dispatching
  `.claude/scripts` work.
- Read relevant low-level `.json` or `.summary.json` files only when module
  context is useful.
- Use `trace-query.mjs` for call-graph questions instead of loading
  `.calls.json` sidecars.
- Treat traces as advisory. Verify critical assumptions against source.

## Git Policy

`.gitignore` keeps low-level traces and staleness cache out of version control.
If a trace command creates or updates ignored low-level files during local work,
do not add them to commits.
