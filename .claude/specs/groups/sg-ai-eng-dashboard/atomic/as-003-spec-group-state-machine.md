---
id: as-003-spec-group-state-machine
title: Spec Group State Machine
spec_group: sg-ai-eng-dashboard
requirements_refs: [REQ-003]
status: implemented
---

# Spec Group State Machine

## References

- **Requirements**: REQ-003
- **Parent Spec Section**: spec.md#acceptance-criteria
- **Spec Group**: sg-ai-eng-dashboard

## Description

Implement the spec group lifecycle state machine with defined states and valid transitions. The UI displays current state and enables/disables transition buttons based on state validity. All transitions are atomic and logged.

## Acceptance Criteria

- **AC3.1**: Spec group detail shows current state badge (DRAFT, REVIEWED, APPROVED, IN_PROGRESS, CONVERGED, MERGED)
- **AC3.2**: Transition buttons rendered based on current state
- **AC3.3**: Valid transitions enabled (e.g., DRAFT → REVIEWED)
- **AC3.4**: Invalid transitions disabled with tooltip explaining why
- **AC3.5**: State transition persists to DynamoDB atomically
- **AC3.6**: State transition logged in decision_log with timestamp and actor

## Test Strategy

- Unit tests for state machine transition logic
- Unit tests for button enable/disable logic per state
- Integration test for DynamoDB persistence
- Tests for invalid transition rejection

Test file: `packages/core/backend-core/src/spec-groups/__tests__/stateMachine.test.ts`

## Deployment Notes

- State machine logic in shared backend-core package
- UI components consume state machine configuration
- No migration needed if SpecGroups table has state field

## Rollback Strategy

- Revert to previous state machine version
- Invalid states may need manual DynamoDB correction

## Atomicity Justification

| Criterion | Justification |
|-----------|---------------|
| **Independently Testable** | State machine logic testable in isolation with no UI |
| **Independently Deployable** | State machine can ship before other spec group features |
| **Independently Reviewable** | Clear scope: state definitions and transition rules |
| **Independently Reversible** | State machine version can be reverted if bugs found |

## Implementation Evidence

| File | Line | Description |
|------|------|-------------|
| `packages/core/backend-core/src/spec-groups/types.ts` | 1-80 | State machine types: SpecGroupState enum, SpecGroup, DecisionLogEntry, TransitionStateInput |
| `packages/core/backend-core/src/spec-groups/stateMachine.ts` | 1-165 | State machine logic: TRANSITION_DEFINITIONS, validateTransition, getAvailableTransitions, STATE_DISPLAY_CONFIG |
| `packages/core/backend-core/src/spec-groups/errors.ts` | 1-28 | Custom errors: SpecGroupNotFoundError, InvalidStateTransitionError, SpecGroupConflictError |
| `packages/core/backend-core/src/spec-groups/repository.ts` | 1-330 | DynamoDB repository with atomic transitionState using conditional expressions |
| `apps/node-server/src/handlers/specGroups.handler.ts` | 1-220 | API handlers: GET /api/spec-groups/:id, POST /api/spec-groups/:id/transition, PUT /api/spec-groups/:id/flags |
| `apps/node-server/src/services/specGroupRepo.service.ts` | 1-15 | Live SpecGroupRepository layer for Effect DI |
| `apps/node-server/src/layers/app.layer.ts` | 1-18 | Updated AppLayer to include LiveSpecGroupRepoProvided |
| `apps/node-server/src/index.ts` | 77-92 | Express routes for spec group endpoints |

## Test Evidence

| Test File | Test Name | ACs Covered |
|-----------|-----------|-------------|
| `packages/core/backend-core/src/spec-groups/__tests__/stateMachine.test.ts` | `TRANSITION_DEFINITIONS - defines exactly 5 valid transitions` | AC3.3 |
| `packages/core/backend-core/src/spec-groups/__tests__/stateMachine.test.ts` | `getValidNextStates - returns REVIEWED as the only valid next state from DRAFT` | AC3.3 |
| `packages/core/backend-core/src/spec-groups/__tests__/stateMachine.test.ts` | `validateTransition - DRAFT->REVIEWED - fails when sections not completed` | AC3.3, AC3.4 |
| `packages/core/backend-core/src/spec-groups/__tests__/stateMachine.test.ts` | `validateTransition - invalid transitions - fails for skipping states` | AC3.4 |
| `packages/core/backend-core/src/spec-groups/__tests__/stateMachine.test.ts` | `getAvailableTransitions - returns enabled transition when preconditions met` | AC3.2, AC3.3 |
| `packages/core/backend-core/src/spec-groups/__tests__/stateMachine.test.ts` | `getAvailableTransitions - returns disabled transition with reason when preconditions fail` | AC3.2, AC3.4 |
| `packages/core/backend-core/src/spec-groups/__tests__/stateMachine.test.ts` | `STATE_DISPLAY_CONFIG - provides correct labels` | AC3.1 |
| `packages/core/backend-core/src/spec-groups/__tests__/repository.test.ts` | `transitionState - updates state and appends to decision log atomically` | AC3.5, AC3.6 |
| `packages/core/backend-core/src/spec-groups/__tests__/repository.test.ts` | `transitionState - throws InvalidStateTransitionError for invalid transition` | AC3.4 |
| `apps/node-server/src/__tests__/handlers/specGroups.handler.test.ts` | `getSpecGroupRequestHandler - returns spec group with state display and available transitions` | AC3.1, AC3.2, AC3.3 |
| `apps/node-server/src/__tests__/handlers/specGroups.handler.test.ts` | `getSpecGroupRequestHandler - returns disabled transition with tooltip reason` | AC3.4 |
| `apps/node-server/src/__tests__/handlers/specGroups.handler.test.ts` | `transitionStateRequestHandler - transitions state and returns updated spec group` | AC3.5, AC3.6 |
| `apps/node-server/src/__tests__/handlers/specGroups.handler.test.ts` | `transitionStateRequestHandler - returns 409 on concurrent modification` | AC3.5 |

## Decision Log

- `2026-01-17T20:50:00Z`: Created from spec.md decomposition
- `2026-01-17T21:XX:00Z`: Implementation completed with state machine in backend-core, DynamoDB repository with atomic transitions, API endpoints in node-server
