---
last_reviewed: 2025-12-12
stage: planning
---

# ADR-0006: Add aspect ejection system

Status: Proposed

Context:

- The repo includes optional “aspects” (e.g., analytics pipeline) that are useful during development but may need to be permanently removed for slimmer variants or downstream forks.
- Manual tear‑out is error‑prone because analytics touches multiple workspaces (apps, CDK stacks, shared outputs, server routes, deps, and docs).

Decision:

- Introduce a config‑driven codemod CLI `scripts/eject-aspect.mjs` plus per‑aspect definitions under `scripts/aspects/*.aspect.mjs`.
- Implement the first aspect definition for `analytics`, covering deletions and deterministic file transforms, with `--dry-run` support and idempotent behavior.

Consequences (Positive/Negative):

- Positive: repeatable, one‑command removal of cross‑cutting features; easier to maintain slim forks; pattern supports future aspects.
- Negative: ejection scripts must be kept in sync with repo structure; transforms may need updates as code evolves.

Related:
