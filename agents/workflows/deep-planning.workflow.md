---
Title: Deep Planning Workflow
---

Intent

- Produce a contract-first, risk-aware planning package that de-risks delivery before implementation begins.

Global Prompts

- Retrieval: Load context per `agents/memory-bank.md`, including project brief, active context, progress log, relevant tech/system patterns, and any applicable ADRs.
- Behaviors: Harvest requirements into measurable criteria, explore alternatives with scoring, define invariants, plan experiments/spikes, budget performance/capacity, model threats and authZ, map PII, specify observability, trace tests to requirements, and design rollout/runbook before task emission.
- Outputs must remain editable Markdown artifacts; link supporting diagrams (Mermaid, ASCII, or external references) alongside text summaries.

Phase: plan

- Goal: Understand business/user needs, translate them into measurable objectives, and scope deliverables.
- Inputs: Request or ticket, stakeholder notes, product/technical briefs, compliance requirements, existing system diagrams/contracts, progress & active context memory.
- Checklist:
  - Clarify problem statement, target users, and measurable success criteria (p95/p99, error budgets, adoption metrics, etc.).
  - Capture Non-goals and explicit exclusions.
  - Identify stakeholders, decision owners, required reviewers, and sign-off expectations.
  - Enumerate dependencies, SLAs, quotas, compliance hooks, and environmental constraints.
  - Inventory existing interfaces, data stores, workflows, and prior ADRs that influence scope.
  - Catalog assumptions, unknowns, and required spikes/experiments with timeboxes.
  - Map impacted components and high-risk areas needing deep dives (perf, security, migration, regulatory).
  - Draft deliverable outline assigning each required artifact to a section owner and planned format.
- Outputs: Problem & Objectives write-up (with Non-goals and success metrics), Constraints & Dependencies sheet, stakeholder matrix with review gates, assumption/unknown log, deliverable outline with owners & due dates.
- Gates: Success metrics are quantifiable, reviewers identified, dependencies listed with status, and unknowns have resolution plans.
- Next: build

Phase: build

- Goal: Author the full deep-planning artifact suite with explicit contracts, models, and risk mitigations.
- Checklist:
  - **Architecture**: Produce component diagram (Mermaid/text) showing data/control flow, list interfaces, resilience patterns, and shared dependencies. Create sequence diagrams for the top three flows and a state machine for any complex stateful logic.
  - **Interface Contracts**: Define REST/gRPC/GraphQL schemas, request/response types, field-level validation, idempotency keys, pagination/versioning approach, error taxonomy (codes, retriable flags), and deprecation policy.
  - **Data Model & Migration**: Specify tables/collections with schemas, invariants, indexes, partitioning/sharding, retention policies, PII classification, encryption requirements, and migration/backfill/rollback plans.
  - **Algorithm / Logic Specs**: Provide pseudocode or state transitions, list invariants/properties that must hold, note concurrency / ordering requirements, and outline experiments or spikes to validate tricky logic.
  - **Alternatives & Tradeoffs**: Document ≥3 options (A/B/C) with a scoring table across performance, complexity, cost, risk, delivery time, operability; justify selected approach and fallback.
  - **Risk Register & Pre-mortem**: Record top risks with likelihood/impact, early warning signals, mitigations/owners, and 6-month failure scenarios with prevention/response tactics.
  - **Performance & Capacity**: State load assumptions, sizing math (queue/backlog, DB QPS, write amplification, throughput), CPU/memory/latency budgets, capacity headroom policy, and performance/chaos test plan.
  - **Security & Privacy**: Run a mini-STRIDE threat model, produce an authZ matrix (role × action × rationale), outline key/secret management, list data flows with PII tagging, and cite compliance obligations.
  - **Observability Spec**: Enumerate required metrics (name, unit, dimensions, SLO tie-in), structured logs/events with fields, trace/span design, dashboards, and alert thresholds with escalation paths.
  - **Testing Strategy & Traceability**: Build a requirements ↔ tests matrix (unit/integration/e2e/perf/fuzz/property/golden/chaos), define fixtures/mocks, data seeding strategies, and validation for negative/error paths.
  - **Rollout & Release Plan**: Detail feature flags, shadow/dual writes, canary step percentages & exit criteria, rollback triggers, data recovery plan, and communication cadence.
  - **Ops & Runbook**: Draft alert response playbooks (symptom → diagnosis → remediation), on-call checklist, SLO/error budget policy, and post-incident follow-up expectations.
  - **Work Plan**: Define milestones, critical path dependencies, resource/owner map, review gates (architecture, security, privacy, compliance, performance), ADRs required, and entrance/exit criteria before build tasks start.
  - **Cross-checks**: Ensure invariants/property definitions align with contracts/data models, confirm experiments/spikes are scheduled, and tag open issues needing external approvals.
- Outputs: Comprehensive deep-planning dossier with numbered sections matching checklist items, option scoring table, risk register, traceability matrix, rollout/runbook appendices, and work plan timeline with review gate assignments.
- Gates: Every mandated deliverable completed with citations, invariants reconciled across artifacts, chosen option justified against scorecard, and unresolved risks flagged with owners/timelines.
- Next: verify

Phase: verify

- Goal: Validate completeness, secure sign-offs, and lock the plan for execution.
- Checklist:
  - Run structured review against deliverable checklist; mark each item pass/block with notes.
  - Confirm measurable success criteria align with performance/capacity budgets and testing strategy.
  - Validate interface contracts against architecture diagrams and data models for consistency.
  - Ensure PII map, threat model, and authZ matrix cover all data flows and roles; resolve compliance/legal approvals.
  - Reconcile risk register with rollout/runbook contingencies and ensure mitigations are testable.
  - Verify requirements ↔ tests matrix has no gaps and references planned suites or test IDs.
  - Capture review gate sign-offs (name/date/decision) for architecture, security/privacy, performance, data, product, and operations leads; record outstanding follow-ups with due dates.
  - Update Memory Bank artifacts (active context, progress log, patterns/ADRs if applicable) with outcomes and lessons.
  - Run `npm run memory:validate` and `npm run memory:drift`; resolve issues before completion.
  - Only after all required approvals and validations, emit execution tasks or tickets.
- Outputs: Review checklist with statuses, sign-off log, updated Memory Bank notes, validation results, final go/no-go decision with conditions.
- Gates: All deliverables verified, validations pass, sign-offs captured, and no critical risks remain unmitigated.
- Next: done

End

- Close with summary of decisions, follow-up tasks, and distribution plan for the deep-planning dossier.
