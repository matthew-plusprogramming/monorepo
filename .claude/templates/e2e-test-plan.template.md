---
template_type: e2e-test-plan
version: '1.0'
description: Maps contract definitions to E2E test cases for the e2e-test-writer agent
---

# E2E Test Plan: {{spec_group_id}}

## Spec Reference

- **Spec Group**: {{spec_group_id}}
- **Spec Path**: `.claude/specs/groups/{{spec_group_id}}/spec.md`
- **Date**: {{date}}

## Cross-Boundary Contract Inventory

List all cross-boundary contracts from the spec. Cross-boundary = process, network, or deployment boundary (HTTP, SSE, WebSocket, database, external service). Module-to-module imports within the same process are NOT cross-boundary.

| Contract Name     | Template Type                               | Boundary Type                          | Source            |
| ----------------- | ------------------------------------------- | -------------------------------------- | ----------------- |
| {{contract_name}} | {{rest-api\|event\|data-model\|behavioral}} | {{HTTP\|SSE\|WebSocket\|DB\|external}} | {{spec line ref}} |

## Contract-to-Test Mapping

### REST API Contracts (`.claude/contracts/templates/rest-api.template.yaml`)

For each REST API contract:

| Field          | Value                      | Test Assertion                            |
| -------------- | -------------------------- | ----------------------------------------- |
| method         | {{GET\|POST\|PUT\|DELETE}} | Request uses correct HTTP method          |
| path           | {{/api/v1/...}}            | Request targets correct endpoint path     |
| content_type   | {{application/json}}       | Request Content-Type header matches       |
| request_shape  | {{fields}}                 | Request body matches expected shape       |
| response_shape | {{fields}}                 | Response body matches expected shape      |
| error_codes    | {{codes}}                  | Error responses use expected status codes |

**Test type**: HTTP (fetch/supertest)
**Test file**: `tests/e2e/{{spec_group_id}}/api-{{endpoint-name}}.test.ts`

### Event Contracts (`.claude/contracts/templates/event.template.yaml`)

For each event contract:

| Field         | Value               | Test Assertion                       |
| ------------- | ------------------- | ------------------------------------ |
| event_name    | {{resource.action}} | Event name matches expected pattern  |
| channel       | {{channel_name}}    | Subscription on correct channel      |
| payload_shape | {{fields}}          | Event payload matches expected shape |

**Test type**: HTTP (EventSource/WebSocket client)
**Test file**: `tests/e2e/{{spec_group_id}}/event-{{event-name}}.test.ts`

### Data Model Contracts (`.claude/contracts/templates/data-model.template.yaml`)

For each data model contract with external-facing implications:

| Field         | Value          | Test Assertion                         |
| ------------- | -------------- | -------------------------------------- |
| entity_name   | {{Entity}}     | API responses reference correct entity |
| fields        | {{field_list}} | Response fields match data model       |
| relationships | {{relations}}  | Related entities accessible via API    |

**Test type**: HTTP (verify data model through API responses)
**Test file**: `tests/e2e/{{spec_group_id}}/data-{{entity-name}}.test.ts`

### Behavioral Contracts (`.claude/contracts/templates/behavioral.template.yaml`)

For each behavioral contract:

| Field              | Value         | Test Assertion                               |
| ------------------ | ------------- | -------------------------------------------- |
| behavior_name      | {{name}}      | Behavior observable through external surface |
| retry_policy       | {{policy}}    | Retry behavior matches contract              |
| timeout            | {{duration}}  | Timeout behavior matches contract            |
| ordering_guarantee | {{guarantee}} | Event/response ordering verified             |
| concurrency        | {{model}}     | Concurrent requests handled correctly        |
| idempotency        | {{rule}}      | Repeated requests produce same result        |

**Test type**: Depends on boundary (Playwright for UI, HTTP for API)
**Test file**: `tests/e2e/{{spec_group_id}}/behavior-{{name}}.test.ts`

## AC-to-Test Case Mapping

For each cross-boundary acceptance criterion:

| AC ID      | AC Description  | Contract Ref      | Test Type            | Test File | Status                                   |
| ---------- | --------------- | ----------------- | -------------------- | --------- | ---------------------------------------- |
| {{AC-X.Y}} | {{description}} | {{contract_name}} | {{Playwright\|HTTP}} | {{path}}  | {{pending\|generated\|passing\|failing}} |

## Test Data Plan

### Credentials

| Context                 | Credential Source          | Notes                   |
| ----------------------- | -------------------------- | ----------------------- |
| E2E test authentication | Dedicated test credentials | Never shared with dev   |
| Admin operations        | Dedicated test admin       | For setup/teardown only |

### Namespace Isolation

- **Run ID format**: `e2e-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
- **Data prefix pattern**: `${RUN_ID}-{{entity-name}}`
- All created test data must use the run-ID prefix

### Cleanup Verification

For each test that creates data:

| Resource Created | Cleanup Method      | Verification        |
| ---------------- | ------------------- | ------------------- |
| {{resource}}     | {{DELETE /api/...}} | {{GET returns 404}} |

## URL Targets

| Target       | URL                                | Purpose                   |
| ------------ | ---------------------------------- | ------------------------- |
| Dev server   | `http://localhost:{{port}}`        | Primary test target       |
| Health check | `http://localhost:{{port}}/health` | Server availability check |

Only localhost and known preview domains are permitted. No arbitrary external URLs.

## Health Check Configuration

- **Timeout**: 30 seconds per attempt
- **Max retries**: 3
- **Backoff**: Exponential (1s, 2s, 4s)
- **Endpoint**: `/health` (convention-based, override per spec if needed)
- **Failure behavior**: Report clear error, tests still generated for later execution

## Test Quality Checklist

- [ ] Each test is deterministic given consistent server state
- [ ] Each test sets up its own preconditions
- [ ] Each test cleans up after itself with verified cleanup
- [ ] No test-to-test ordering dependency
- [ ] All assertions are on external inputs/outputs only (black-box)
- [ ] Test data uses run-ID prefix for namespace isolation
- [ ] Dedicated test credentials used (not shared with dev)
- [ ] URL targets restricted to localhost and known preview domains
- [ ] Suite execution target: under 5 minutes
