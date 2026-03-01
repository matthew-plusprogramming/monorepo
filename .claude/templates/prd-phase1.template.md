---
id: prd-<slug>
title: <Product/Feature Name>
version: 1.0
state: draft
author: <name>
date: <YYYY-MM-DD>
last_updated: <YYYY-MM-DD>
---

# <Product/Feature Name>

<!-- PRD Writer: This is the D-034 minimum structure template.
     All 9 required sections MUST be present in every PRD.
     Conditional sections are included when applicable.
     The PRD describes WHAT and WHY — never HOW (no implementation details). -->

---

## 1. Title & Summary

<!-- PRD Writer: One paragraph summarizing the problem being solved, who it affects,
     and why it matters. This is the elevator pitch for the entire effort.
     Keep it concise — 3-5 sentences maximum. -->

**Problem**: <One-paragraph problem statement describing the pain point, who experiences it, and the impact of not solving it.>

---

## 2. Success Criteria

<!-- PRD Writer: Measurable acceptance criteria that define "done."
     Each criterion should be verifiable — a human or automated check can confirm it.
     Use checkbox format for trackability. Quantify where possible. -->

- [ ] SC-1: <Measurable outcome>
- [ ] SC-2: <Measurable outcome>
- [ ] SC-3: <Measurable outcome>

---

## 3. Success Metrics

<!-- PRD Writer: Post-shipping impact measurements. These are tracked AFTER launch
     to determine whether the feature achieved its intended business/product impact.
     Different from Success Criteria (which are pre-launch verification). -->

| Metric        | Baseline        | Target         | Measurement Method | Timeframe         |
| ------------- | --------------- | -------------- | ------------------ | ----------------- |
| <Metric name> | <Current state> | <Target value> | <How measured>     | <When to measure> |

---

## 4. Scope Boundaries

<!-- PRD Writer: Explicitly state what IS and IS NOT included.
     In-scope items define the work. Out-of-scope items prevent scope creep.
     Future considerations capture deferred work without losing it. -->

### In Scope

- <Feature or capability explicitly included>

### Out of Scope

- <Feature or capability explicitly excluded> — <Why excluded>

### Future Considerations

- <Deferred item> — <Why deferred, potential timeline>

---

## 5. User Stories or Flows

<!-- PRD Writer: Describe how users interact with the feature.
     Use narrative flows (Step 1, 2, 3) or user story format (As a X, I want Y, so that Z).
     Cover the primary happy path and key alternative paths. -->

### Primary Flow: <Flow Name>

1. User does X
2. System responds with Y
3. User sees Z

### Alternative Flow: <Flow Name>

1. <Alternative path>

---

## 6. Non-Functional Requirements

<!-- PRD Writer: Performance, security, scalability, accessibility, reliability requirements.
     Each NFR should have a measurable target where possible. -->

| ID    | Requirement   | Target              | Priority        |
| ----- | ------------- | ------------------- | --------------- |
| NFR-1 | <Requirement> | <Measurable target> | Must/Should/May |
| NFR-2 | <Requirement> | <Measurable target> | Must/Should/May |

---

## 7. Risks & Edge Cases

<!-- PRD Writer: Known risks, failure modes, and edge cases.
     Include likelihood, impact, and mitigation strategy for each risk.
     Edge cases should describe boundary conditions and expected behavior. -->

### Risks

| Risk               | Likelihood   | Impact       | Mitigation            |
| ------------------ | ------------ | ------------ | --------------------- |
| <Risk description> | High/Med/Low | High/Med/Low | <Mitigation strategy> |

### Edge Cases

- **EC-1**: <Edge case description> — Expected behavior: <what should happen>
- **EC-2**: <Edge case description> — Expected behavior: <what should happen>

---

## 8. Decisions Log

<!-- PRD Writer: This section tracks all critic findings and their resolutions.
     It is populated during the gather-criticize loop.
     Each entry follows the structured schema below.
     Critics check this log before raising findings to prevent re-litigation. -->

| ID           | Critic                                  | Severity                   | Finding                                | Resolution                   | Rationale                        | Pass          |
| ------------ | --------------------------------------- | -------------------------- | -------------------------------------- | ---------------------------- | -------------------------------- | ------------- |
| <finding_id> | <business/technical/security/edge-case> | <Critical/High/Medium/Low> | <One-line summary of what was flagged> | <accepted/rejected/deferred> | <Why this resolution was chosen> | <pass_number> |

<!-- Decisions Log Entry Schema:
     - finding_id: Unique identifier (e.g., BIZ-001, TECH-003, SEC-002, EDGE-001)
     - critic_type: Which perspective raised it (business, technical, security, edge-case)
     - severity: At time of finding (Critical, High, Medium, Low)
     - finding_summary: What was flagged — one line
     - resolution: accepted (PRD amended), rejected (not a real gap), deferred (acknowledged but out of scope)
     - rationale: Why this resolution was chosen
     - pass_number: Which gather-criticize pass produced this finding -->

---

## 9. Amendment Log

<!-- PRD Writer: This section tracks post-approval changes to the PRD.
     Every change after the initial gather-criticize loop exits must be recorded here.
     This provides full version history of the PRD's evolution. -->

| Version   | Date         | What Changed                  | Why                                                    | Acknowledged By                         |
| --------- | ------------ | ----------------------------- | ------------------------------------------------------ | --------------------------------------- |
| <version> | <YYYY-MM-DD> | <Section and specific change> | <Human decision / Compliance finding / Team discovery> | <Which consumers have seen this change> |

<!-- Amendment Log Entry Schema:
     - version: PRD version after this amendment (e.g., 1.1, 1.2)
     - date: When the amendment was made
     - what_changed: Which section, which requirement — be specific
     - why: What triggered the change (human decision, Compliance finding, team discovery during implementation)
     - acknowledged_by: Which consumers (spec groups, teams) have been notified of and acknowledged this change -->

---

<!-- CONDITIONAL SECTIONS: Include the following sections when applicable. -->

## UX Considerations

<!-- PRD Writer: Include this section WHERE the PRD describes a user-facing feature.
     Cover target users, interaction patterns, accessibility, and visual requirements.
     Omit this section for purely backend/infrastructure work. -->

### Target Users

- **<User type>**: <Description and needs>

### Interaction Patterns

- <Key interaction pattern or visual requirement>

### Accessibility

- <Accessibility requirements>

---

## Milestones

<!-- PRD Writer: Include this section WHERE the PRD scope warrants incremental delivery.
     Break the work into meaningful increments that deliver user value.
     Omit for small-scope PRDs that ship as a single unit. -->

| Milestone  | Scope             | Target | Dependencies              |
| ---------- | ----------------- | ------ | ------------------------- |
| M1: <name> | <What's included> | <When> | <What must be done first> |
| M2: <name> | <What's included> | <When> | <Dependencies>            |
