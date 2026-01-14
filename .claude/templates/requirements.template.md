---
spec_group: sg-<group-id>
source: prd | pm-interview | manual
prd_version: v1
last_updated: <YYYY-MM-DD>
---

# Requirements

## Source

- **Origin**: <PRD link | PM interview | Manual entry>
- **PRD Version**: <v1, v2, etc. or N/A>
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

| Requirement | Atomic Specs | Status |
|-------------|--------------|--------|
| REQ-001 | as-001-*, as-002-* | Covered |
| REQ-002 | as-003-* | Covered |

## Open Questions

- [ ] <Question about requirement clarity>
- [x] <Resolved question> → <Resolution>

## Change Log

- `<timestamp>`: Initial requirements extracted from PRD v1
- `<timestamp>`: REQ-003 added based on user clarification
