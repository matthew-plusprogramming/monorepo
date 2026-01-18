---
spec_group: sg-ai-eng-dashboard
source: prd
prd_version: v1
last_updated: 2026-01-17
---

# Requirements

## Source

- **Origin**: [PRD: AI-Native Engineering Dashboard](https://docs.google.com/document/d/10e6fcDFw23EjWX4YDR7_aYtUFnBJvujlC9M9hyNqjMQ)
- **PRD Version**: v1
- **Last Synced**: 2026-01-17T20:50:00Z

## Requirements

### REQ-001: Project Dashboard Overview

**Statement**: Users must see all projects at a glance with real-time status indicators.

**EARS Format**:
- WHEN user opens the dashboard
- THE SYSTEM SHALL display all projects with status indicators
- AND show spec group counts and overall health per project
- AND update in real-time as project state changes

**Rationale**: Enables quick assessment of portfolio health without drilling into each project.

**Constraints**: Must load within 3 seconds, handle 5-15 concurrent projects.

---

### REQ-002: PRD Sync from Google Docs

**Statement**: Users must be able to sync PRD content from Google Docs.

**EARS Format**:
- WHEN user clicks "Sync" on a PRD
- THE SYSTEM SHALL fetch the latest content from Google Docs API
- AND update the local PRD record with new content
- AND display the updated version/timestamp
- AND handle API errors gracefully with user feedback

**Rationale**: Google Docs is the source of truth for PRDs; dashboard needs current content.

**Constraints**: Requires valid Google Docs API credentials. Read-only access.

---

### REQ-003: Spec Group Lifecycle Management

**Statement**: Spec groups must follow a defined state machine with valid transitions.

**EARS Format**:
- WHEN user views a spec group
- THE SYSTEM SHALL display the current state (DRAFT, REVIEWED, APPROVED, etc.)
- AND enable buttons for valid state transitions
- AND disable buttons for invalid transitions
- AND persist state changes to DynamoDB

**Rationale**: Enforces workflow discipline and prevents premature implementation.

**Constraints**: State transitions must be atomic and logged.

**States**: DRAFT → REVIEWED → APPROVED → IN_PROGRESS → CONVERGED → MERGED

---

### REQ-004: GitHub Issues Integration

**Statement**: Dashboard must display linked GitHub issues for each project.

**EARS Format**:
- WHEN user views a project's GitHub panel
- THE SYSTEM SHALL fetch and display linked GitHub issues
- AND show issue status (open, closed, in progress)
- AND provide links to GitHub for full context

**Rationale**: Connects planning (specs) to execution (issues).

**Constraints**: Requires GitHub API token with repo read access.

---

### REQ-005: GitHub PRs and CI Status

**Statement**: Dashboard must display linked PRs with CI status.

**EARS Format**:
- WHEN user views a project's GitHub panel
- THE SYSTEM SHALL fetch and display linked pull requests
- AND show PR status (open, merged, draft)
- AND display CI check status (passing, failing, pending)
- AND update status via webhook or polling

**Rationale**: Shows implementation progress and code quality status.

**Constraints**: Requires GitHub API token. CI status from GitHub Actions.

---

### REQ-006: Agent Task Dispatch via Webhooks

**Statement**: Users must be able to dispatch agent tasks via webhooks.

**EARS Format**:
- WHEN user clicks "Implement" or "Run Tests" on a spec group
- THE SYSTEM SHALL send a webhook to the configured agent container
- AND include spec group context in the webhook payload
- AND handle webhook failures gracefully
- AND log the dispatch attempt

**Rationale**: Enables AI agent orchestration without manual intervention.

**Constraints**: Webhooks only accessible within Docker network. 10-second timeout.

---

### REQ-007: Real-time Agent Status

**Statement**: Agent task status must update in real-time.

**EARS Format**:
- WHEN an agent task is running
- THE SYSTEM SHALL display real-time status updates via WebSocket
- AND show task progress indicators
- AND display logs upon task completion
- AND reconnect automatically if WebSocket disconnects

**Rationale**: Provides visibility into autonomous agent work.

**Constraints**: WebSocket connection must be resilient. Status polling fallback.

---

### REQ-008: Convergence Gate Tracking

**Statement**: Dashboard must display convergence gate status per spec group.

**EARS Format**:
- WHEN user views a spec group detail
- THE SYSTEM SHALL display all convergence gates
- AND show gate status (passed, failed, pending, N/A)
- AND update gate status as work progresses
- AND block state transitions if required gates not passed

**Rationale**: Ensures quality gates are met before merge.

**Gates**: Spec complete, ACs implemented, Tests passing, Unifier passed, Code review, Security review, Browser tests, Docs generated.

---

### REQ-009: Password Authentication

**Statement**: Dashboard access must require password authentication.

**EARS Format**:
- WHEN user accesses the dashboard without valid session
- THE SYSTEM SHALL display login form
- AND validate password against stored bcrypt hash
- AND issue secure session token on success
- AND persist session across page refreshes

**Rationale**: Protects personal project data.

**Constraints**: No multi-user; single owner password. Rate limiting on login attempts.

---

### REQ-010: Responsive Design

**Statement**: Dashboard must be usable on all devices.

**EARS Format**:
- WHEN user accesses dashboard from mobile device
- THE SYSTEM SHALL render mobile-optimized layout
- AND provide touch-friendly controls
- AND adapt at breakpoints (768px, 1024px)

**Rationale**: Enables checking project status from any device.

**Constraints**: Mobile-first CSS approach. Test on iOS Safari, Chrome.

---

### REQ-011: Health Monitoring Endpoint

**Statement**: System must expose health endpoint for monitoring.

**EARS Format**:
- WHEN monitoring system queries /api/health
- THE SYSTEM SHALL return JSON with component health status
- AND include DynamoDB connectivity status
- AND include timestamp
- AND respond within 1 second

**Rationale**: Enables external monitoring (UptimeRobot, healthchecks.io).

**Constraints**: No authentication required for health endpoint.

---

### REQ-012: Structured JSON Logging

**Statement**: All API requests must be logged as structured JSON.

**EARS Format**:
- WHEN any API request is processed
- THE SYSTEM SHALL log request details as structured JSON
- AND include timestamp, method, path, status, duration
- AND log to stdout for container aggregation

**Rationale**: Enables log analysis and debugging.

**Constraints**: Must be machine-parseable. No PII in logs.

---

## Traceability

| Requirement | Atomic Specs | Status |
|-------------|--------------|--------|
| REQ-001 | as-001-project-dashboard-overview | Pending |
| REQ-002 | as-002-prd-google-docs-integration | Pending |
| REQ-003 | as-003-spec-group-state-machine | Pending |
| REQ-004 | as-004-github-issues-integration | Pending |
| REQ-005 | as-005-github-prs-integration | Pending |
| REQ-006 | as-006-agent-webhook-dispatch | Pending |
| REQ-007 | as-007-agent-status-realtime | Pending |
| REQ-008 | as-008-convergence-gate-display | Pending |
| REQ-009 | as-009-password-auth | Pending |
| REQ-010 | as-010-responsive-design | Pending |
| REQ-011 | as-011-health-endpoint | Pending |
| REQ-012 | as-012-json-logging | Pending |

## Open Questions

- [ ] Should agent logs be persisted to DynamoDB or just streamed?
- [ ] Polling interval for GitHub status updates when webhooks unavailable?
- [ ] Session expiration time (24h? 7d? configurable?)

## Change Log

- `2026-01-17T20:50:00Z`: Initial requirements extracted from PRD v1
