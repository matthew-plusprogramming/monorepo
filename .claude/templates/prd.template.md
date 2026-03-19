---
id: prd-<slug>
title: <Product/Feature Name>
description: <One-sentence summary of what this PRD covers>
version: 1.0
state: draft
author: <name>
date: <YYYY-MM-DD>
last_updated: <YYYY-MM-DD>
---

# <Product/Feature Name>

## Document Metadata

| Field        | Value        |
| ------------ | ------------ |
| PRD ID       | prd-<slug>   |
| Version      | 1.0          |
| State        | DRAFT        |
| Author       | <name>       |
| Created      | <YYYY-MM-DD> |
| Last Updated | <YYYY-MM-DD> |

---

## Version History

| Version | Date         | Author | State | Summary of Changes |
| ------- | ------------ | ------ | ----- | ------------------ |
| 1.0     | <YYYY-MM-DD> | <name> | DRAFT | Initial draft      |

> **Note**: Agent/system changes create new version as DRAFT. User changes can go directly to REVIEWED.

---

## 1. Problem Statement

**What problem are we solving? Why does it matter?**

<Describe the problem from the user's perspective. Be specific about the pain point, who experiences it, and the impact of not solving it.>

---

## 2. Product Intent

**What is the desired outcome? What does success look like?**

<Describe the intended state after this work is complete. Focus on outcomes, not implementation. This is the canonical expression of intent that all other artifacts derive from.>

---

## 3. Requirements

### Functional Requirements

_Each requirement must be testable and traceable to specs, tests, code, and PRs._

| ID  | Requirement        | Priority     | Notes |
| --- | ------------------ | ------------ | ----- |
| R1  | <Requirement text> | High/Med/Low |       |
| R2  | <Requirement text> | High/Med/Low |       |
| R3  | <Requirement text> | High/Med/Low |       |

### Non-Functional Requirements

_Performance, security, scalability, accessibility, etc._

| ID  | Requirement        | Target              | Notes |
| --- | ------------------ | ------------------- | ----- |
| NF1 | <Requirement text> | <Measurable target> |       |
| NF2 | <Requirement text> | <Measurable target> |       |

---

## 4. Constraints

### Technical Constraints

- <e.g., Must work with existing auth system>
- <e.g., Cannot modify database schema>

### Business Constraints

- <e.g., Must launch before Q2>
- <e.g., Budget limited to X>

### Regulatory/Compliance Constraints

- <e.g., Must comply with GDPR>
- <e.g., Requires accessibility standards>

---

## 5. Integration Surface

_Pre-populated by the integration surface exploration step (Phase 1.5) during the gather-criticize loop. Validate and refine automated findings with stakeholders. This section captures what existing systems, contracts, and boundaries this work touches — critical context for the implementation team._

### Touched Systems

_Existing systems, services, APIs, and databases that this work interacts with. Each entry describes how the system is touched and what contract governs the interaction._

| System/Component     | How Touched                 | Existing Contract                | Risk Level     |
| -------------------- | --------------------------- | -------------------------------- | -------------- |
| <e.g., Auth service> | <Consumes /api/auth/verify> | <OpenAPI spec at docs/auth.yaml> | <Low/Med/High> |

### New Boundaries Created

_Any new integration points this work introduces. Each new boundary needs both sides' contracts documented._

- <New boundary description> -- <Owning side> -- <Contract format>

### Configuration Dependencies

_Environment variables, feature flags, and config files involved. Include both existing config that must be present and new config this work introduces._

| Config Key               | Type      | Source | New/Existing | Required By        |
| ------------------------ | --------- | ------ | ------------ | ------------------ |
| <e.g., AUTH_SERVICE_URL> | <env var> | <.env> | <Existing>   | <Auth integration> |

### Cross-Cutting Concerns

_Shared state, caching layers, event systems, and logging pipelines that span integration boundaries. These are the most common source of subtle cross-boundary bugs._

- <Concern description> -- <Which boundaries it spans> -- <Coordination needed>

---

## 6. Assumptions

_What are we assuming to be true? These will be monitored in production._

| ID  | Assumption        | Confidence   | Validation Method | Expiry Condition    |
| --- | ----------------- | ------------ | ----------------- | ------------------- |
| A1  | <Assumption text> | High/Med/Low | <How to validate> | <When this expires> |
| A2  | <Assumption text> | High/Med/Low | <How to validate> | <When this expires> |

> **Note**: Unstated assumptions are bugs in disguise. All assumptions are first-class citizens that can expire.

---

## 7. Tradeoffs

_What decisions have been made and why?_

| Decision         | Options Considered   | Choice          | Rationale         |
| ---------------- | -------------------- | --------------- | ----------------- |
| <Decision topic> | <Option A, Option B> | <Chosen option> | <Why this choice> |

<Document the tradeoffs explicitly. Future readers need to understand not just what was decided, but why.>

---

## 8. User Experience

### Target Users

- **<User type 1>**: <Description and needs>
- **<User type 2>**: <Description and needs>

### User Flows

#### Flow 1: <Flow Name>

1. User does X
2. System responds with Y
3. User sees Z

### UX Requirements

- <Interaction patterns, visual requirements, accessibility needs>
- <Error states and edge cases from user perspective>

---

## 9. Scope

### In Scope

- <Explicitly list what IS included>
- <Feature or capability>
- <Feature or capability>

### Out of Scope

- <Explicitly list what is NOT included — prevents scope creep>
- <Deferred feature>
- <Excluded capability>

### Future Considerations

- <Things we might do later but are explicitly deferring>
- <Potential enhancement>

---

## 10. Risks & Mitigations

| Risk               | Likelihood   | Impact       | Mitigation            | Owner  |
| ------------------ | ------------ | ------------ | --------------------- | ------ |
| <Risk description> | High/Med/Low | High/Med/Low | <Mitigation strategy> | <name> |

---

## 11. Success Criteria

### Metrics

| Metric        | Current State | Target         | Measurement Method |
| ------------- | ------------- | -------------- | ------------------ |
| <Metric name> | <Baseline>    | <Target value> | <How measured>     |

### Acceptance Criteria (High-Level)

- <What must be true for this PRD to be considered complete?>
- <These will decompose into atomic specs>

---

## 12. Rollout & Monitoring

### Rollout Strategy

- <Phased rollout? Feature flags? A/B test?>

### Monitoring Plan

- <What signals will we watch?>
- <How will we detect if assumptions are violated?>
- <What triggers a rollback?>

---

## 13. Open Questions

| ID  | Question        | Status   | Resolution | Resolved By |
| --- | --------------- | -------- | ---------- | ----------- |
| Q1  | <Question text> | Open     |            |             |
| Q2  | <Question text> | Resolved | <Answer>   | <name>      |

---

## Linked Artifacts

_This section is populated as work progresses (Traceability Matrix)._

### Spec Groups

| Spec Group ID | PRD Version | State | Link   |
| ------------- | ----------- | ----- | ------ |
| sg-<slug>     | 1.0         | DRAFT | <link> |

### Related PRDs

- <Links to related or dependent PRDs>

### Knowledge Base Entries

- <Links to relevant KB articles>

---

## Approval

| Role           | Name | Date | Decision                             |
| -------------- | ---- | ---- | ------------------------------------ |
| Product Owner  |      |      | Approved / Rejected / Needs Revision |
| Technical Lead |      |      | Approved / Rejected / Needs Revision |

---

## State Transition Checklist

**DRAFT → REVIEWED requires:**

- [ ] All sections completed (or explicitly marked N/A)
- [ ] Assumptions documented with validation methods
- [ ] Tradeoffs documented with rationale
- [ ] Success criteria defined and measurable
- [ ] Open questions resolved or explicitly deferred
- [ ] Approval signatures obtained
