---
id: as-007-agent-status-realtime
title: Real-time Agent Status
spec_group: sg-ai-eng-dashboard
requirements_refs: [REQ-007]
status: implemented
---

# Real-time Agent Status

## References

- **Requirements**: REQ-007
- **Parent Spec Section**: spec.md#acceptance-criteria
- **Spec Group**: sg-ai-eng-dashboard

## Description

Display real-time agent task status updates via WebSocket connection. Shows progress indicators while tasks run and displays logs upon completion. Handles reconnection gracefully.

## Acceptance Criteria

- **AC7.1**: Agent panel shows active task with status indicator
- **AC7.2**: Status updates in real-time via WebSocket (no page refresh)
- **AC7.3**: Progress indicator shows task phase (starting, running, completing)
- **AC7.4**: Task logs accessible via expandable section after completion
- **AC7.5**: WebSocket reconnects automatically on disconnect
- **AC7.6**: Reconnection indicator shown when connection drops
- **AC7.7**: Falls back to polling if WebSocket unavailable

## Test Strategy

- Unit tests for status display component
- Unit tests for WebSocket connection logic
- Integration test with mock WebSocket server
- Reconnection logic tests
- Polling fallback tests

Test file: `apps/client-website/src/components/Agent/__tests__/Status.test.tsx`

## Deployment Notes

- WebSocket server endpoint required
- Consider connection pooling for multiple tabs
- Status persisted in DynamoDB for recovery

## Rollback Strategy

- Fall back to polling-only mode
- Show "Real-time updates unavailable" with manual refresh button

## Atomicity Justification

| Criterion | Justification |
|-----------|---------------|
| **Independently Testable** | Can test status UI with mock WebSocket |
| **Independently Deployable** | Real-time status works with or without dispatch |
| **Independently Reviewable** | Scope limited to WebSocket and status display |
| **Independently Reversible** | Fall back to polling without affecting dispatch |

## Implementation Evidence

| File | Line | Description |
|------|------|-------------|
| `packages/core/backend-core/src/agent-tasks/types.ts` | 35-167 | Extended types for real-time status (TaskPhase, AgentTaskRealtimeStatus, WebSocket message types) |
| `packages/core/backend-core/src/agent-tasks/repository.ts` | 78-120 | Repository schema extended with updateRealtimeStatus, addLogEntry, getLogs, getRealtimeStatus |
| `packages/core/backend-core/src/agent-tasks/repository.ts` | 407-636 | Implementation of new repository methods with TTL support |
| `apps/node-server/src/services/websocket.service.ts` | 1-300 | WebSocket server manager with subscription, heartbeat, and broadcast support (AC7.2, AC7.5) |
| `apps/node-server/src/handlers/agentTaskStatus.handler.ts` | 1-175 | Handler for POST /api/agent-tasks/:id/status (AC7.1, AC7.3) and GET endpoints (AC7.4, AC7.7) |
| `apps/node-server/src/index.ts` | 131-145 | Agent task status endpoints registration |
| `apps/node-server/src/index.ts` | 154-163 | WebSocket server initialization on HTTP server |
| `apps/client-website/src/hooks/useAgentTaskStatus.ts` | 1-350 | Client-side WebSocket hook with reconnection (AC7.5, AC7.6) and polling fallback (AC7.7) |

## Test Evidence

| Test File | Test Name | ACs Covered |
|-----------|-----------|-------------|
| `apps/node-server/src/__tests__/handlers/agentTaskStatus.handler.test.ts` | updates task status and returns updated status | AC7.3 |
| `apps/node-server/src/__tests__/handlers/agentTaskStatus.handler.test.ts` | accepts status update with log entry | AC7.4 |
| `apps/node-server/src/__tests__/handlers/agentTaskStatus.handler.test.ts` | returns 404 when task not found | Error handling |
| `apps/node-server/src/__tests__/handlers/agentTaskStatus.handler.test.ts` | returns task status for polling fallback | AC7.7 |
| `apps/node-server/src/__tests__/handlers/agentTaskStatus.handler.test.ts` | returns task logs for completed task | AC7.4 |
| `apps/client-website/src/hooks/__tests__/useAgentTaskStatus.test.ts` | connects to WebSocket on mount | AC7.2 |
| `apps/client-website/src/hooks/__tests__/useAgentTaskStatus.test.ts` | updates status when receiving WebSocket message | AC7.2 |
| `apps/client-website/src/hooks/__tests__/useAgentTaskStatus.test.ts` | shows reconnecting state when connection drops | AC7.5, AC7.6 |
| `apps/client-website/src/hooks/__tests__/useAgentTaskStatus.test.ts` | falls back to polling after max reconnect attempts | AC7.7 |

## Decision Log

- `2026-01-17T20:50:00Z`: Created from spec.md decomposition
- `2026-01-17T21:30:00Z`: Implemented WebSocket server with ws library, agent status update endpoint, and client-side hook
- `2026-01-17T21:30:00Z`: Decision: Agent logs persisted to DynamoDB with 30-day TTL (as per resolved open question)
- `2026-01-17T21:30:00Z`: Decision: POST /api/agent-tasks/:id/status endpoint does not require auth (for agent callbacks)
