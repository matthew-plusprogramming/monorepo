# [Product/Feature Name] - PRD

**Version**: v1
**Status**: DRAFT | REVIEWED
**Owner**: [Name]
**Last Updated**: [Date]

---

## Overview

Brief description of what this product/feature is and why it matters. 2-3 sentences that capture the essence.

## Goals

What we're trying to achieve:

- Goal 1: [Measurable outcome]
- Goal 2: [Measurable outcome]
- Goal 3: [Measurable outcome]

## Non-Goals

Explicitly out of scope for this effort:

- Non-goal 1: [What we're NOT doing and why]
- Non-goal 2: [What we're NOT doing and why]

---

## Requirements

### REQ-001: [Requirement Title]

[Clear description of what the system must do]

**EARS Format**:
- WHEN [trigger/condition]
- THE SYSTEM SHALL [required behavior]
- AND [additional behavior if any]

**Rationale**: Why this requirement exists.

**Priority**: Must Have | Should Have | Nice to Have

---

### REQ-002: [Requirement Title]

[Description]

**EARS Format**:
- WHEN [trigger]
- THE SYSTEM SHALL [behavior]

**Rationale**: [Why]

**Priority**: [Priority]

---

### REQ-003: [Requirement Title]

[Description]

**EARS Format**:
- WHILE [state/condition]
- THE SYSTEM SHALL [behavior]

**Rationale**: [Why]

**Priority**: [Priority]

---

## Constraints

Technical, business, or regulatory limitations:

- **Technical**: [e.g., Must work on IE11, Must support 10k concurrent users]
- **Business**: [e.g., Must launch before Q2, Budget limited to $X]
- **Regulatory**: [e.g., Must comply with GDPR, Must be SOC2 compliant]

## Assumptions

Things we're assuming to be true:

- **Assumption 1**: [Statement] — [Impact if wrong]
- **Assumption 2**: [Statement] — [Impact if wrong]
- **Assumption 3**: [Statement] — [Impact if wrong]

## Success Criteria

How we'll know this is successful:

- [ ] Criterion 1: [Measurable outcome, e.g., "95% of users complete checkout in < 2 minutes"]
- [ ] Criterion 2: [Measurable outcome]
- [ ] Criterion 3: [Measurable outcome]

## Open Questions

Unresolved items that need answers:

- [ ] **Q1**: [Question] — Owner: [Name], Due: [Date]
- [ ] **Q2**: [Question] — Owner: [Name], Due: [Date]
- [x] **Q3**: [Resolved question] → **Answer**: [Resolution]

---

## User Stories (Optional)

If using Agile methodology, map user stories to requirements:

| Story | As a... | I want... | So that... | Req |
|-------|---------|-----------|------------|-----|
| US-1 | User | to log out | my session is secure | REQ-001 |
| US-2 | Admin | to see audit logs | I can track changes | REQ-003 |

---

## Implementation Notes

_Section added during implementation - contains technical decisions and discoveries_

### [Date]: [Decision Title]

**Context**: [What prompted this decision]

**Decision**: [What was decided]

**Trade-offs**: [What we gained/lost]

**Requirements Impact**: [Any new requirements or changes]

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| v1 | [Date] | [Name] | Initial draft |
| v2 | [Date] | [Name] | Added REQ-003 based on security review |

---

## EARS Format Reference

For writing requirements:

| Pattern | When to Use | Template |
|---------|-------------|----------|
| **Ubiquitous** | Always true | THE SYSTEM SHALL [behavior] |
| **Event-driven** | Triggered by event | WHEN [event], THE SYSTEM SHALL [behavior] |
| **State-driven** | While in state | WHILE [state], THE SYSTEM SHALL [behavior] |
| **Optional** | Feature-flagged | WHERE [feature enabled], THE SYSTEM SHALL [behavior] |
| **Unwanted** | Error handling | IF [bad condition], THEN THE SYSTEM SHALL [recovery] |

**Good requirement example**:
```
WHEN user clicks "Submit Order"
THE SYSTEM SHALL validate payment information
AND create order record
AND send confirmation email within 30 seconds
```

**Bad requirement example**:
```
The system should be fast and user-friendly.
(Not testable, not specific)
```
