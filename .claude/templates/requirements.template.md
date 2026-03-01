---
spec_group: sg-<group-id>
description: <One-sentence summary of the requirements>
source: prd | prd-gathering | manual
prd_version: 1
last_updated: <YYYY-MM-DD>
---

# Requirements

## Source

- **Origin**: <PRD link | PM interview | Manual entry>
- **PRD Version**: <1, 2, 1.0, 2.0, etc. or N/A>
- **Last Synced**: <timestamp or N/A>

## Requirements

### REQ-001: <Requirement Title>

**Statement**: <Clear, testable requirement in EARS format>

**EARS Format**:

- WHEN <trigger/condition>
- THE SYSTEM SHALL <behavior>
- AND <additional behavior>

**Rationale**: <Why this requirement exists>

**Constraints**: <Any constraints on implementation>

**Assumptions**: <Assumptions that must hold>

---

### REQ-002: <Requirement Title>

**Statement**: <Clear, testable requirement>

**EARS Format**:

- WHEN <trigger/condition>
- THE SYSTEM SHALL <behavior>

**Rationale**: <Why this requirement exists>

---

## Traceability

| Requirement | Atomic Specs       | Status  |
| ----------- | ------------------ | ------- |
| REQ-001     | as-001-_, as-002-_ | Covered |
| REQ-002     | as-003-\*          | Covered |

## Open Questions

- [ ] <Question about requirement clarity>
- [x] <Resolved question> → <Resolution>

## Change Log

- `<timestamp>`: Initial requirements extracted from PRD 1
- `<timestamp>`: REQ-003 added based on user clarification
