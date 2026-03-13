---
last_reviewed: 2026-03-12
---

# Practice Index

Canonical locations for all numbered practices in the metaclaude-assistant system.

| Practice | Name                          | Canonical File                                         | Line | Description                                                              |
| -------- | ----------------------------- | ------------------------------------------------------ | ---- | ------------------------------------------------------------------------ |
| 1.4      | Recursive Conductor           | `CLAUDE.md`                                            | 64   | Workstream agents are conductors, not just executors; max depth 3 levels |
| 1.5      | Pre-Computed Structure        | `CLAUDE.md`                                            | 70   | Use human-provided decomposition directly; atomizer is fallback          |
| 1.6      | File-Based Coordination       | `CLAUDE.md`                                            | 74   | Sentinel files for trivial inter-agent coordination instead of dispatch  |
| 1.7      | Evidence-Before-Edit          | `.claude/memory-bank/best-practices/contract-first.md` | 7    | Prove symbols exist before referencing them; evidence table required     |
| 1.8      | Wire Protocol Contracts       | `CLAUDE.md`                                            | 341  | Cross-boundary integration points need explicit protocol contracts       |
| 1.9      | Boundary Ownership Assignment | `CLAUDE.md`                                            | 345  | Each integration boundary has exactly one owning spec                    |
| 1.10     | Assumption Tracking           | `CLAUDE.md`                                            | 313  | Scan TODO(assumption) markers for conflicts across parallel agents       |
| 2.4      | Independent Verification      | `CLAUDE.md`                                            | 309  | Test-writer must not see implementation; tests verify contract only      |
| 2.5      | Contract Stratification       | `CLAUDE.md`                                            | 349  | Four contract layers: type, symbol, wire protocol, behavioral            |
| 4.2      | Progress Heartbeat Discipline | `.claude/memory-bank/tech.context.md`                  | 196  | Implementers must log progress updates; heartbeat monitors staleness     |
| 4.5      | Integration Verification Gate | `CLAUDE.md`                                            | 331  | Cross-boundary wiring check after parallel implementation                |
