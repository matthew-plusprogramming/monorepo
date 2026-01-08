---
last_reviewed: 2026-01-07
---

# Project Brief

Opinionated TypeScript monorepo: Express 5 server (optionally packaged for AWS Lambda) and CDK for Terraform (CDKTF) infrastructure, with repo-native agent workflows and a durable Memory Bank for knowledge capture.

## Scope & High Level Goals

- Build and maintain a Node/Express service with strong typing (Effect), validation (Zod), and clear boundaries.
- Define CDKTF stacks (DynamoDB, CloudWatch, Lambda packaging) and typed consumers; ensure app loads infra outputs rather than hardcoding.
- Make agent collaboration first-class via Memory Bank and Skills/Subagents; enable structured workflows for software development.
- Provide shared packages for schemas/utilities/configs to keep implementations consistent across workspaces.
- Constraints: keep changes minimal and localized; prioritize clarity over production hardening at this stage.

## Out of Scope & Non Goals

- Production hardening (HA, autoscaling, multi-region) and full test coverage.
- Cost optimization and advanced operational hardening.

## Primary Users & Stakeholders

- Agents: execute repo-native workflows via skills and subagents; capture durable facts in canonical files.
- Maintainers/Developers: fast onboarding via consistent patterns, typed boundaries, and validated workflows.
- Infra Maintainers: predictable CDKTF outputs and typed consumption paths used by the app.

## Project Stage

Planning; initial scaffolding exists across app, packages, and CDKTF. Skills and subagents are integrated into the development workflow.

## Success Criteria

- Clear entrypoints and invariants documented under `.claude/memory-bank/*`.
- Skills and subagents present, validated, and used for all non-trivial changes.
- App: `npm -w node-server run dev` runs with CDKTF outputs loaded; Lambda packaging path works end-to-end.
- Infra: stacks synth/deploy; outputs written under `cdktf-outputs/**` and consumed via `@cdk/platform-cdk`.
- Quality: `npm run phase:check` passes in CI; recurring patterns captured in memory bank.
