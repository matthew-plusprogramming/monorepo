last_reviewed: 2025-09-03
stage: planning

# Project Brief
Opinionated TypeScript monorepo: Express 5 server (optionally packaged for AWS Lambda) and CDK for Terraform (CDKTF) infrastructure, with repo‑native agent workflows and a durable Memory Bank for knowledge capture.

Scope & High Level Goals
- Build and maintain a Node/Express service with strong typing (Effect), validation (Zod), and clear boundaries.
- Define CDKTF stacks (DynamoDB, CloudWatch, Lambda packaging) and typed consumers; ensure app loads infra outputs rather than hardcoding.
- Make agent collaboration first‑class via Memory Bank and Workflow Process files; enable Workflow Synthesis from recurring procedural patterns.
- Provide shared packages for schemas/utilities/configs to keep implementations consistent across workspaces.
- Constraints: keep changes minimal and localized; prioritize clarity over production hardening at this stage.

Out of Scope & Non Goals
- Production hardening (HA, autoscaling, multi‑region) and full test coverage.
- Cost optimization and advanced operational hardening.

Primary Users & Stakeholders
- Agents: execute repo‑native workflows; capture durable facts in canonical files; synthesize workflows from patterns.
- Maintainers/Developers: fast onboarding via consistent patterns, typed boundaries, and validated memory workflows.
- Infra Maintainers: predictable CDKTF outputs and typed consumption paths used by the app.

Project Stage
Planning; initial scaffolding exists across app, packages, and CDKTF. Memory Bank and Workflows are being integrated into daily changes.

Success Criteria
- Clear entrypoints and invariants documented under `agents/memory-bank/*`.
- Memory Bank and Workflows present, validated, and used for all changes.
- App: `npm -w node-server run dev` runs with CDKTF outputs loaded; Lambda packaging path works end‑to‑end.
- Infra: stacks synth/deploy; outputs written under `cdktf-outputs/**` and consumed via `@cdk/backend-server-cdk`.
- Memory: `npm run memory:validate` and `npm run memory:drift` pass in CI; recurring patterns captured in `system.patterns.md` and reflected in workflows when warranted.
