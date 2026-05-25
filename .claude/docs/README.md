# .claude/docs

Technical reference docs. CLAUDE.md is the runtime preamble loaded every session; this directory holds deeper references read on demand. Only docs that are operationally load-bearing for the runtime agent are linked directly from CLAUDE.md — everything else lives here.

## Active systems

- [HOOKS.md](HOOKS.md) — PreToolUse / PostToolUse / Stop hook reference
- [STRUCTURED-DOCS.md](STRUCTURED-DOCS.md) — YAML structured-docs registry (architecture, flows, glossary)
- [SYNC-SYSTEM.md](SYNC-SYSTEM.md) — Metaclaude sync manager (distributes artifacts to consumer projects)
- [SYNC-SYSTEM-INTERNALS.md](SYNC-SYSTEM-INTERNALS.md) — Sync internals (registry, hashes, bundles)
- [ENFORCEMENT-FLOW.md](ENFORCEMENT-FLOW.md) — Cross-hook sequence diagrams for manifest validation, `SubagentStop` dispatch-record fallback, and vibe-mode positive-assertion flow
- [MANIFEST-MIGRATION.md](MANIFEST-MIGRATION.md) — Spec-group manifest shape, strict validation, and legacy migration repair
- [SCHEMA-VALIDATION.md](SCHEMA-VALIDATION.md) — Spec schema validator (Ajv delegation, section-validation scoping, sibling validator map)
- [SPEC-FRONTMATTER.md](SPEC-FRONTMATTER.md) — Runtime-connectivity frontmatter fields (`runtime_env`, `crosses_boundary`, `runtime_connectivity_budget_ms`, `security_surface`, `pure_compute_entry_points`) and widened `e2e_skip_rationale` enum
- [WORKFLOW-ENFORCEMENT.md](WORKFLOW-ENFORCEMENT.md) — Gate enforcement, stop hook, file protection
- [deployment-verification-contracts.md](deployment-verification-contracts.md) — `verify:build` / `verify:deploy` contract interfaces
- [SILENT-DROP-OBSERVABILITY.md](SILENT-DROP-OBSERVABILITY.md) — Silent-drop detection system: CLI scripts, Zod schemas, advisory→coercive rollout, audit-chain integrity, file protection
- [RTC-ENFORCEMENT-AUDIT.md](RTC-ENFORCEMENT-AUDIT.md) — Runtime-connectivity enforcement audit system: flag file, hash-chained audit log, chain verifier, mode resolver, quarantine ritual, `workflow-file-protection` extension (`rtc-` prefix; distinct from silent-drop's audit chain)

## Runtime Connectivity Authoring Pattern

- [RUNTIME-CONNECTIVITY-AUTHORING.md](RUNTIME-CONNECTIVITY-AUTHORING.md) — User guide: how spec authors get auto-generated E2E tests from the e2e-test-writer agent
- [RUNTIME-CONNECTIVITY-ARCHETYPES.md](RUNTIME-CONNECTIVITY-ARCHETYPES.md) — Archetype reference (http-smoke, ws-event, sse-stream, cli-writes-file, ipc-ping-pong) + placeholder grammar
- [RUNTIME-CONNECTIVITY-LIB-API.md](RUNTIME-CONNECTIVITY-LIB-API.md) — API reference for `.claude/scripts/lib/e2e-test-writer/` (exported symbols, error classes, input/output shapes)

## Pure-Compute Static-Analysis Sub-Check

- [PURE-COMPUTE-CHECK.md](PURE-COMPUTE-CHECK.md) — Overview: SEC-F3 defense, Gate 5 integration, fail-closed semantics, four sentinel symbols
- [PURE-COMPUTE-CHECK-API.md](PURE-COMPUTE-CHECK-API.md) — API reference for `.claude/scripts/lib/pure-compute-*.mjs` (7 modules + shared path-containment util)
- [PURE-COMPUTE-CHECK-BLOCKLIST.md](PURE-COMPUTE-CHECK-BLOCKLIST.md) — Authoritative blocklist reference (module-level + callsite-level + sentinels + safelist)

## Skill / subagent internals

- [DOC-AUDIT.md](DOC-AUDIT.md) — `/doc-audit` skill and doc-auditor agent
- [FLOW-VERIFIER.md](FLOW-VERIFIER.md) — `/flow-verify` skill and flow-verifier agent

## Contributor references

- [CONFIG.md](CONFIG.md) — `.claude/config/` YAML schema reference
- [PROMPTS.md](PROMPTS.md) — prompts directory and prompt-vs-skill distinction
- [SCRIPT-TESTING.md](SCRIPT-TESTING.md) — vitest testing patterns for `.claude/scripts/`
