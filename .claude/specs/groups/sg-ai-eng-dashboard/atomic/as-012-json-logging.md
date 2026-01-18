---
id: as-012-json-logging
title: Structured JSON Logging
spec_group: sg-ai-eng-dashboard
requirements_refs: [REQ-012]
status: implemented
---

# Structured JSON Logging

## References

- **Requirements**: REQ-012
- **Parent Spec Section**: spec.md#acceptance-criteria
- **Spec Group**: sg-ai-eng-dashboard

## Description

Implement structured JSON logging for all API requests. Each log entry includes timestamp, method, path, status, duration, and request ID. Logs written to stdout for container aggregation.

## Acceptance Criteria

- **AC12.1**: All API requests logged on completion
- **AC12.2**: Log entry includes: timestamp (ISO 8601), method, path, status code
- **AC12.3**: Log entry includes: duration (ms), request ID
- **AC12.4**: Log format is valid JSON (one object per line)
- **AC12.5**: Logs written to stdout
- **AC12.6**: No PII in logs (user passwords, tokens)
- **AC12.7**: Error logs include stack trace in separate field

## Test Strategy

- Unit tests for log formatter
- Integration tests verifying log output
- Tests for PII redaction
- JSON validity tests

Test file: `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts`

## Deployment Notes

- Configure container runtime to aggregate stdout logs
- Consider log rotation for local development
- JSON format compatible with common log aggregators (CloudWatch, Datadog)

## Rollback Strategy

- Disable logging middleware
- Revert to console.log for debugging

## Atomicity Justification

| Criterion | Justification |
|-----------|---------------|
| **Independently Testable** | Can test logging middleware in isolation |
| **Independently Deployable** | Logging ships as middleware without API changes |
| **Independently Reviewable** | Scope limited to logging middleware and formatter |
| **Independently Reversible** | Disable middleware with no functional impact |

## Implementation Evidence

| File | Line | Description |
|------|------|-------------|
| `apps/node-server/src/middleware/logging.middleware.ts` | 1-189 | Logging middleware implementation with PII redaction |
| `apps/node-server/src/middleware/logging.middleware.ts` | 116-167 | `createLoggingMiddleware` - captures request/response and logs on completion (AC12.1) |
| `apps/node-server/src/middleware/logging.middleware.ts` | 140-151 | Log entry structure with timestamp, method, path, statusCode, durationMs, requestId (AC12.2, AC12.3) |
| `apps/node-server/src/middleware/logging.middleware.ts` | 91-93 | `formatLogEntry` - produces single-line JSON output (AC12.4) |
| `apps/node-server/src/middleware/logging.middleware.ts` | 101-103 | `defaultLogOutput` - writes to stdout (AC12.5) |
| `apps/node-server/src/middleware/logging.middleware.ts` | 9-29 | `SENSITIVE_FIELDS` - list of PII fields to redact (AC12.6) |
| `apps/node-server/src/middleware/logging.middleware.ts` | 61-85 | `redactSensitiveFields` - recursive redaction (AC12.6) |
| `apps/node-server/src/middleware/logging.middleware.ts` | 152-159 | Error handling with stack trace in separate field (AC12.7) |
| `apps/node-server/src/middleware/logging.middleware.ts` | 178-187 | `loggingErrorMiddleware` - attaches errors for logging |
| `apps/node-server/src/index.ts` | 18-21, 35, 55-56 | Integration of logging middleware in Express app |

## Test Evidence

| Test File | Test Name | ACs Covered |
|-----------|-----------|-------------|
| `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts` | logs request on completion with all required fields | AC12.1, AC12.2, AC12.3 |
| `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts` | produces valid JSON output | AC12.4 |
| `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts` | writes to provided output function | AC12.5 |
| `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts` | does not include authorization header value in logs | AC12.6 |
| `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts` | does not include cookie values in logs | AC12.6 |
| `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts` | does not log request body with passwords | AC12.6 |
| `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts` | redacts password fields | AC12.6 |
| `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts` | redacts token fields | AC12.6 |
| `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts` | includes error message in separate field when error is attached | AC12.7 |
| `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts` | includes stack trace in error field | AC12.7 |
| `apps/node-server/src/__tests__/middleware/logging.middleware.test.ts` | keeps error in separate field from main log entry | AC12.7 |

## Decision Log

- `2026-01-17T20:50:00Z`: Created from spec.md decomposition
- `2026-01-18T05:50:00Z`: Implemented logging middleware with all ACs verified by tests
