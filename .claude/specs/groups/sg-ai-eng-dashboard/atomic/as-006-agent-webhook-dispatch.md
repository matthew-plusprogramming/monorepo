---
id: as-006-agent-webhook-dispatch
title: Agent Webhook Dispatch
spec_group: sg-ai-eng-dashboard
requirements_refs: [REQ-006]
status: implemented
---

# Agent Webhook Dispatch

## References

- **Requirements**: REQ-006
- **Parent Spec Section**: spec.md#acceptance-criteria
- **Spec Group**: sg-ai-eng-dashboard

## Description

Implement webhook dispatch to trigger agent tasks in containerized environments. When user clicks "Implement" or "Run Tests", a webhook is sent to the configured agent container with spec group context.

## Acceptance Criteria

- **AC6.1**: "Implement" and "Run Tests" buttons visible on spec group detail
- **AC6.2**: Clicking button sends POST webhook to configured endpoint
- **AC6.3**: Webhook payload includes spec group ID, action type, and context
- **AC6.4**: Button shows loading state during dispatch
- **AC6.5**: Success toast shown on webhook acknowledgment
- **AC6.6**: Error toast with retry option on webhook failure
- **AC6.7**: Dispatch attempt logged to AgentTasks table

## Test Strategy

- Unit tests for dispatch button states
- Unit tests for webhook payload construction
- Integration test with mocked webhook endpoint
- Error handling tests (timeout, network failure)

Test file: `apps/client-website/src/components/Agent/__tests__/Dispatch.test.tsx`

## Deployment Notes

- Agent container must be running on Docker network
- AGENT_WEBHOOK_URL environment variable required
- 10-second timeout on webhook calls

## Rollback Strategy

- Disable dispatch buttons with "Agent dispatch temporarily unavailable"
- No data impact, purely UI disable

## Atomicity Justification

| Criterion | Justification |
|-----------|---------------|
| **Independently Testable** | Can test dispatch with mocked webhook endpoint |
| **Independently Deployable** | Dispatch works without real-time status feature |
| **Independently Reviewable** | Scope limited to dispatch logic and UI |
| **Independently Reversible** | Disable buttons without affecting other agent features |

## Implementation Evidence

| File | Line | Description |
|------|------|-------------|
| `packages/core/backend-core/src/agent-tasks/types.ts` | 1-102 | AgentTask types with TTL support (30 days), action types, status types |
| `packages/core/backend-core/src/agent-tasks/errors.ts` | 1-34 | Custom error types: AgentTaskNotFoundError, WebhookDispatchError, WebhookTimeoutError, WebhookNotConfiguredError |
| `packages/core/backend-core/src/agent-tasks/repository.ts` | 1-270 | DynamoDB repository with create, getById, updateStatus operations and TTL support |
| `packages/core/backend-core/src/agent-tasks/webhookService.ts` | 1-130 | Webhook dispatch service with 10-second timeout handling |
| `packages/core/backend-core/src/agent-tasks/index.ts` | 1-10 | Module exports |
| `apps/node-server/src/handlers/agentDispatch.handler.ts` | 1-210 | API handlers for POST /api/spec-groups/:id/dispatch (AC6.2, AC6.3) and GET /api/agent-tasks/:id |
| `apps/node-server/src/services/agentTaskRepo.service.ts` | 1-16 | Live AgentTaskRepository service layer |
| `apps/node-server/src/services/webhook.service.ts` | 1-16 | Live WebhookService layer |
| `apps/node-server/src/layers/app.layer.ts` | 1-24 | Updated app layer with AgentTaskRepo and WebhookService |
| `apps/node-server/src/index.ts` | 114-124 | API routes for agent dispatch endpoints (AS-006) |
| `packages/core/backend-core/src/testing/fakes/agentTaskRepo.ts` | 1-160 | Fake AgentTaskRepository for testing |
| `packages/core/backend-core/src/testing/fakes/webhookService.ts` | 1-120 | Fake WebhookService for testing |

## Test Evidence

| Test File | Test Name | ACs Covered |
|-----------|-----------|-------------|
| `apps/node-server/src/__tests__/handlers/agentDispatch.handler.test.ts` | dispatches implement action and creates task | AC6.2, AC6.3, AC6.7 |
| `apps/node-server/src/__tests__/handlers/agentDispatch.handler.test.ts` | dispatches test action correctly | AC6.2, AC6.3 |
| `apps/node-server/src/__tests__/handlers/agentDispatch.handler.test.ts` | returns 404 when spec group not found | AC6.2 |
| `apps/node-server/src/__tests__/handlers/agentDispatch.handler.test.ts` | returns 503 when webhook URL not configured | AC6.2 |
| `apps/node-server/src/__tests__/handlers/agentDispatch.handler.test.ts` | returns 502 on webhook dispatch failure | AC6.6 |
| `apps/node-server/src/__tests__/handlers/agentDispatch.handler.test.ts` | returns 504 on webhook timeout | AC6.6 |
| `apps/node-server/src/__tests__/handlers/agentDispatch.handler.test.ts` | validates action in request body | AC6.2 |
| `apps/node-server/src/__tests__/handlers/agentDispatch.handler.test.ts` | includes context with spec group name in dispatch | AC6.3 |
| `apps/node-server/src/__tests__/handlers/agentDispatch.handler.test.ts` | returns agent task when found | AC6.7 |
| `apps/node-server/src/__tests__/handlers/agentDispatch.handler.test.ts` | returns 404 when task not found | AC6.7 |
| `packages/core/backend-core/src/agent-tasks/__tests__/repository.test.ts` | returns Some when agent task exists | AC6.7 |
| `packages/core/backend-core/src/agent-tasks/__tests__/repository.test.ts` | returns None when agent task does not exist | AC6.7 |
| `packages/core/backend-core/src/agent-tasks/__tests__/repository.test.ts` | creates a new agent task with TTL | AC6.7 |
| `packages/core/backend-core/src/agent-tasks/__tests__/repository.test.ts` | updates status to DISPATCHED with timestamp | AC6.7 |
| `packages/core/backend-core/src/agent-tasks/__tests__/repository.test.ts` | updates status to FAILED with error message | AC6.6, AC6.7 |

## Decision Log

- `2026-01-17T20:50:00Z`: Created from spec.md decomposition
- `2026-01-17T22:35:00Z`: Implemented backend API for agent webhook dispatch with Effect-based error handling, DynamoDB persistence with 30-day TTL, and 10-second webhook timeout
