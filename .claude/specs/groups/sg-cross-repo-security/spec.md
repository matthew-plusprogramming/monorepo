---
id: task-cross-repo-security
title: Cross-Repo Security Hardening from ai-eng-dashboard
date: 2026-02-20
status: draft
---

# Cross-Repo Security Hardening from ai-eng-dashboard

## Context

Six security hardening atomic specs were identified by analyzing the ai-eng-dashboard repository's commit history. Each addresses a concrete security vulnerability or adds a hardening layer to the monorepo's node-server application and supporting scripts. These changes range from error message masking to subprocess sandboxing, and each can be implemented and tested independently.

### Key Codebase Observations

1. **Error message leakage**: The `generateRequestHandler` in `packages/core/backend-core/src/request.handler.ts` (line 73) sends `error.message` directly in the fallback path. Multiple handlers (login, register, dashboardLogin) pass `e.message` through their `mapper` functions for `InternalServerError`, exposing internal details like "Failed to verify password: ..." or "Failed to hash password: ...". Additionally, `githubIssues.handler.ts` and `githubPRs.handler.ts` leak `e.message` through `GitHubApiError` (502) and `GitHubAuthError` (401) mappers. There are ~20+ mapper instances across 13 handler files.

2. **HMAC verification without size guard**: `webhookAuthMiddleware` in `apps/node-server/src/middleware/webhookAuth.middleware.ts` calls `JSON.stringify(req.body)` and then computes HMAC on the full body with no size check. Express `json()` middleware parses the body before the webhook middleware runs.

3. **Full environment inheritance**: Scripts at `cdk/platform-cdk/scripts/cdk-bootstrap-migrate.ts`, `cdk/platform-cdk/scripts/cdk-output.ts`, `cdk/platform-cdk/scripts/copy-lambda-artifacts.ts`, and `apps/node-server/scripts/bundle-argon-2.ts` (lines 31, 56) use `execSync(..., { env: process.env })`, `spawnSync(...)` with default environment, or `env: { ...process.env }`, passing all secrets to child processes.

4. **Inconsistent input validation**: Most handlers use `parseInput()` (which calls `.parse()` and throws). Some POST endpoints (e.g., `agentTaskStatus.handler.ts`) use this pattern, but route parameters like `:id` are used as `req.params.id as string` without validation (e.g., `specGroups.handler.ts` line 77, `agentTaskStatus.handler.ts` line 61).

5. **No subprocess concurrency control**: No limiter exists for child process spawning, though current subprocess usage is limited to build scripts.

## Goal

Port six security hardening atomic specs (from five source improvements) from the ai-eng-dashboard repo into this monorepo, addressing error information disclosure, DoS prevention, environment isolation, input validation, and resource exhaustion.

## Requirements Summary

See `requirements.md` for full EARS-format requirements.

| ID      | Title                                         | Priority  |
| ------- | --------------------------------------------- | --------- |
| REQ-001 | Mask internal error messages in API responses | Must Have |
| REQ-002 | Payload size guard before HMAC verification   | Must Have |
| REQ-003 | Minimal env allowlist for child processes     | Must Have |
| REQ-004 | Zod safeParse audit on POST endpoints         | Must Have |
| REQ-005 | Concurrency limiter for subprocess spawning   | Must Have |

## Acceptance Criteria

### AS-001: Mask Internal Error Messages in API Responses (REQ-001)

- **AC1.1**: The `generateRequestHandler` fallback (line 73 of `request.handler.ts`) returns `"Internal server error"` instead of `error.message`
- **AC1.2**: The fallback path logs the real `error.message` via `console.error` (or structured logger) before sending the generic response
- **AC1.3**: All `InternalServerError` mapper functions in handler `statusCodesToErrors` return generic messages (not `e.message`)
- **AC1.4**: Mappers for `InternalServerError` in these handlers are updated: `login.handler.ts`, `register.handler.ts`, `dashboardLogin.handler.ts`, `agentTaskStatus.handler.ts`, `specGroups.handler.ts`, `getUser.handler.ts`, `heartbeat.handler.ts`, `health.handler.ts`, `projects.handler.ts`, `agentDispatch.handler.ts`, `githubIssues.handler.ts`, `githubPRs.handler.ts`, `dashboardLogout.handler.ts` (~20+ mapper instances)
- **AC1.5**: `GitHubApiError` (502) and `GitHubAuthError` (401) mappers in `githubIssues.handler.ts` and `githubPRs.handler.ts` return generic messages (internal API errors, not user-facing)
- **AC1.6**: 400-level error mappers (ZodError, NotFound, Conflict, InvalidCredentials) continue returning user-facing messages, not raw exception strings

### AS-002: Payload Size Guard and DoS Prevention (REQ-002)

- **AC2.1**: The `webhookAuthMiddleware` checks `Content-Length` header before HMAC verification
- **AC2.2**: Requests with `Content-Length` exceeding `MAX_WEBHOOK_PAYLOAD_BYTES` (default 1MB = 1048576) are rejected with HTTP 413 before any HMAC computation
- **AC2.3**: When `Content-Length` is missing, the middleware reads body with a streaming size limit and aborts if exceeded
- **AC2.4**: The size check occurs BEFORE the `validateWebhookSignature()` call
- **AC2.5**: `MAX_WEBHOOK_PAYLOAD_BYTES` is configurable via environment variable with 1048576 as default
- **AC2.6**: The Express `json()` body parser is configured with a `limit` option matching or below the webhook payload limit
- **AC2.7**: In-memory collections in `dashboardRateLimiting.middleware.ts` have capacity bounds (MAX_EVENTS, MAX_ENTRIES) and evict oldest entries when exceeded (note: `ipRateLimiting.middleware.ts` uses DynamoDB, not in-memory)

### AS-003: Minimal Env Allowlist for Child Processes (REQ-003)

- **AC3.1**: A `buildChildEnv(additionalKeys?: string[])` function exists at `scripts/utils/child-env.mjs` (plain ESM, importable from both `apps/` and `cdk/`)
- **AC3.2**: Default allowlist includes: `PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `NODE_ENV`, `LOG_LEVEL`
- **AC3.3**: All env vars matching `CLAUDE_*` and `ANTHROPIC_*` patterns are automatically included
- **AC3.4**: Additional keys can be passed per-callsite and are merged into the allowlist
- **AC3.5**: The function logs a warning when a requested additional key is not present in `process.env`
- **AC3.6**: `cdk/platform-cdk/scripts/cdk-bootstrap-migrate.ts` uses `buildChildEnv()` instead of `process.env`
- **AC3.7**: `cdk/platform-cdk/scripts/cdk-output.ts` uses `buildChildEnv()` instead of `process.env`
- **AC3.8**: `cdk/platform-cdk/scripts/copy-lambda-artifacts.ts` uses `buildChildEnv()` for any `spawnSync` calls
- **AC3.9**: `apps/node-server/scripts/bundle-argon-2.ts` uses `buildChildEnv()` instead of `{ ...process.env }` at both child_process callsites (lines 31 and 56)

### AS-004: Route Parameter Validation Middleware (REQ-004)

- **AC4.1**: Route parameters containing user-supplied IDs are validated with `/^[a-zA-Z0-9_:-]{1,128}$/` or equivalent
- **AC4.2**: A shared `validateRouteParam(paramName, regex)` middleware or utility exists at `apps/node-server/src/middleware/validateRouteParam.middleware.ts`
- **AC4.3**: Route parameter validation is in place for all routes: `/api/spec-groups/:id`, `/api/spec-groups/:id/transition`, `/api/spec-groups/:id/flags`, `/api/agent-tasks/:id`, `/api/agent-tasks/:id/status`, `/api/agent-tasks/:id/logs`, `/api/projects/:id`, `/api/projects/:id/github/issues`, `/api/projects/:id/github/pulls`, `/user/:identifier`

Note: `getUser.handler.ts` already has handler-level Zod validation via `GetUserSchema`; route-level `validateRouteParam()` middleware provides defense-in-depth.

### AS-006: Zod Body Validation Audit on POST Endpoints (REQ-004)

- **AC6.1**: Every POST/PUT/PATCH handler in `apps/node-server/src/` has a Zod schema for request body validation
- **AC6.2**: Request bodies are validated before processing (existing `parseInput()` usage counts as validated)
- **AC6.3**: Failed validation returns HTTP 400 with structured field-level error messages (no internal details)

### AS-005: Concurrency Limiter for Subprocess Spawning (REQ-005)

- **AC5.1**: `ProcessConcurrencyLimiter` class exists with `acquire()` and `release()` methods
- **AC5.2**: Default max concurrency is 5, configurable via `MAX_CONCURRENT_PROCESSES` env var
- **AC5.3**: `acquire()` returns a Promise that resolves when a slot is available; queues if full
- **AC5.4**: `release()` frees a slot and dequeues the next waiter in FIFO order
- **AC5.5**: `acquire(timeoutMs)` rejects after the timeout if no slot is available
- **AC5.6**: Async subprocess spawning call sites (currently only `bundle-argon-2.ts`) wrap spawn/exec in acquire/release with try/finally. Synchronous CDK scripts do NOT need wrapping.
- **AC5.7**: `_resetForTest()` method clears internal state for test isolation
- **AC5.8**: Queue fairness is enforced: waiters served in FIFO order

## Design Notes

### AS-001: Error Masking Architecture

The key change point is `generateRequestHandler` in `packages/core/backend-core/src/request.handler.ts`. The current pattern:

```typescript
// Line 73 - CURRENT (leaks error.message)
res.status(HTTP_RESPONSE.INTERNAL_SERVER_ERROR).send(error.message);
```

Must become:

```typescript
// FIXED - generic message, log real error
console.error('[UnhandledError]', error.message, error.cause);
res.status(HTTP_RESPONSE.INTERNAL_SERVER_ERROR).send('Internal server error');
```

For handler-level mappers, the current pattern:

```typescript
[HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
  errorType: InternalServerError,
  mapper: (e) => e.message,  // LEAKS internal message
}
```

Must become:

```typescript
[HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
  errorType: InternalServerError,
  mapper: () => ({ error: 'Internal server error' }),  // GENERIC
}
```

Note: The `InternalServerError` messages like `"Failed to verify password: <raw error>"` are created in `verifyPassword()` and `hashPassword()` functions. These messages are fine for server-side logging (via the `console.error(error.cause)` on line 40 of `request.handler.ts`) but must not reach the HTTP response.

### AS-002: Payload Size Guard

The Express `json()` middleware on line 100 of `index.ts` already parses the body before `webhookAuthMiddleware` runs. Two approaches:

1. **Option A**: Add a `limit` option to `express.json()` globally (e.g., `express.json({ limit: '1mb' })`) AND add an explicit size check in `webhookAuthMiddleware` before HMAC.
2. **Option B**: Use a dedicated body parser for webhook routes with a size limit, separate from the global parser.

Recommendation: Option A is simpler. The `express.json({ limit: '1mb' })` prevents oversized bodies from reaching any endpoint. The webhook middleware adds an explicit check on `req.headers['content-length']` as defense-in-depth before HMAC.

### AS-003: Child Environment Utility

Location: `scripts/utils/child-env.mjs` (plain ESM, importable from both `apps/` and `cdk/`)

```javascript
const DEFAULT_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'NODE_ENV', 'LOG_LEVEL',
];
const PATTERN_ALLOWLIST = [/^CLAUDE_/, /^ANTHROPIC_/];

export function buildChildEnv(additionalKeys = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (PATTERN_ALLOWLIST.some(p => p.test(key)) && value) env[key] = value;
  }
  for (const key of additionalKeys) {
    if (process.env[key]) {
      env[key] = process.env[key];
    } else {
      console.warn(`[buildChildEnv] Requested env var '${key}' not present in process.env`);
    }
  }
  return env;
}
```

### AS-004: Route Parameter Validation

A shared middleware for route param validation:

```typescript
const SAFE_ID_REGEX = /^[a-zA-Z0-9_:-]{1,128}$/;

export const validateRouteParam =
  (paramName: string, regex = SAFE_ID_REGEX): RequestHandler =>
  (req, res, next) => {
    const value = req.params[paramName];
    if (!value || !regex.test(value)) {
      res.status(400).json({ error: `Invalid ${paramName} parameter` });
      return;
    }
    next();
  };
```

### AS-005: Concurrency Limiter

```typescript
class ProcessConcurrencyLimiter {
  private active = 0;
  private queue: Array<{ resolve: () => void; reject: (e: Error) => void }> =
    [];

  constructor(private maxConcurrency: number = 5) {}

  async acquire(timeoutMs?: number): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return;
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.queue.push(entry);
      if (timeoutMs) {
        setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(
              new Error(
                `Timed out waiting for process slot after ${timeoutMs}ms`,
              ),
            );
          }
        }, timeoutMs);
      }
    });
  }

  release(): void {
    const next = this.queue.shift(); // FIFO
    if (next) {
      next.resolve();
    } else {
      this.active--;
    }
  }

  _resetForTest(): void {
    this.active = 0;
    this.queue = [];
  }
}
```

## Task List

### AS-001 Tasks

- [x] T1.1: Update `generateRequestHandler` fallback (line 73 of `request.handler.ts`) to return generic "Internal server error" and log real error (AC1.1, AC1.2)
- [x] T1.2: Update `InternalServerError` mapper in `login.handler.ts` to return generic message (AC1.3, AC1.4)
- [x] T1.3: Update `InternalServerError` mapper in `register.handler.ts` to return generic message (AC1.3, AC1.4)
- [x] T1.4: Update `InternalServerError` mapper in `dashboardLogin.handler.ts` to return generic message (AC1.3, AC1.4)
- [x] T1.5: Audit and update `InternalServerError` mappers in all remaining handlers, plus `GitHubApiError`/`GitHubAuthError` mappers in `githubIssues.handler.ts` and `githubPRs.handler.ts` (AC1.3, AC1.4, AC1.5, AC1.6)

### AS-002 Tasks

- [x] T2.1: Add `Content-Length` check to `webhookAuthMiddleware` before HMAC verification, rejecting with 413 if exceeded (AC2.1, AC2.2, AC2.4)
- [x] T2.2: Add streaming body size limit for requests without `Content-Length` header (AC2.3)
- [x] T2.3: Make `MAX_WEBHOOK_PAYLOAD_BYTES` configurable via env var with 1048576 default (AC2.5)
- [x] T2.4: Add `limit` option to `express.json()` in `index.ts` (AC2.6)
- [x] T2.5: Add capacity bounds (MAX_EVENTS, MAX_ENTRIES) to in-memory collections in `dashboardRateLimiting.middleware.ts` with oldest-entry eviction (AC2.7)

### AS-003 Tasks

- [x] T3.1: Create `buildChildEnv()` utility function at `scripts/utils/child-env.mjs` with default allowlist (AC3.1, AC3.2)
- [x] T3.2: Add `CLAUDE_*` and `ANTHROPIC_*` pattern matching to `buildChildEnv()` (AC3.3)
- [x] T3.3: Add `additionalKeys` parameter support with missing-key warnings (AC3.4, AC3.5)
- [x] T3.4: Update `cdk/platform-cdk/scripts/cdk-bootstrap-migrate.ts` to use `buildChildEnv()` (AC3.6)
- [x] T3.5: Update `cdk/platform-cdk/scripts/cdk-output.ts` to use `buildChildEnv()` (AC3.7)
- [x] T3.6: Audit and update `cdk/platform-cdk/scripts/copy-lambda-artifacts.ts` for `buildChildEnv()` usage (AC3.8)
- [x] T3.7: Update `apps/node-server/scripts/bundle-argon-2.ts` to use `buildChildEnv()` at both callsites (AC3.9)

### AS-004 Tasks

- [x] T4.1: Create `validateRouteParam()` shared middleware with configurable regex (AC4.2)
- [x] T4.2: Add `validateRouteParam('id')` to all `:id` routes in `index.ts` (AC4.1, AC4.3)
- [x] T4.3: Add `validateRouteParam('identifier')` to `/user/:identifier` route (AC4.1, AC4.3)

### AS-006 Tasks

- [x] T6.1: Audit all POST/PUT/PATCH handlers for Zod body validation completeness (AC6.1, AC6.2)
- [x] T6.2: Add Zod schema validation to any POST endpoint found missing it (AC6.1, AC6.3) -- audit confirmed all already validated
- [x] T6.3: Verify all validation error responses return structured field-level messages without internal details (AC6.3)

### AS-005 Tasks

- [x] T5.1: Create `ProcessConcurrencyLimiter` class with `acquire()`, `release()`, `_resetForTest()` (AC5.1, AC5.3, AC5.4, AC5.7)
- [x] T5.2: Add configurable max concurrency via `MAX_CONCURRENT_PROCESSES` env var (AC5.2)
- [x] T5.3: Implement timeout parameter on `acquire()` (AC5.5)
- [x] T5.4: Ensure FIFO queue ordering for waiters (AC5.8)
- [x] T5.5: Wrap async subprocess call sites with acquire/release -- currently only `bundle-argon-2.ts` (AC5.6)
- [x] T5.6: Write comprehensive tests for limiter (concurrency, timeout, FIFO, reset) (AC5.1-AC5.8) -- class created with full API, tests deferred to test-writer

## Test Plan

### AS-001 Tests

- AC1.1 -> Unit test: `request.handler.ts` fallback sends `"Internal server error"`, not `error.message`
- AC1.2 -> Unit test: `request.handler.ts` fallback logs real error to console.error
- AC1.3 -> Unit test per handler: `InternalServerError` mapper returns generic message
- AC1.4 -> Code review: all 13 handler files updated (~20+ mapper instances)
- AC1.5 -> Unit test: `GitHubApiError`/`GitHubAuthError` mappers return generic messages
- AC1.6 -> Unit test: 400-level mappers still return user-facing messages (ZodError, NotFound, etc.)

### AS-002 Tests

- AC2.1 -> Unit test: middleware rejects request with Content-Length > 1MB with 413
- AC2.2 -> Unit test: rejection occurs before `validateWebhookSignature` is called
- AC2.3 -> Integration test: streaming body larger than limit is aborted
- AC2.4 -> Code review: size check precedes HMAC verification in code flow
- AC2.5 -> Unit test: custom `MAX_WEBHOOK_PAYLOAD_BYTES` env var overrides default
- AC2.6 -> Integration test: express.json rejects oversized bodies
- AC2.7 -> Unit test: dashboardRateLimiting maps enforce capacity bounds and evict oldest entries

### AS-003 Tests

- AC3.1 -> Unit test: `buildChildEnv()` returns object with only allowlisted keys
- AC3.2 -> Unit test: default output includes PATH, HOME, USER, SHELL, TERM, NODE_ENV, LOG_LEVEL
- AC3.3 -> Unit test: CLAUDE_API_KEY and ANTHROPIC_API_KEY are included when present
- AC3.4 -> Unit test: additionalKeys are merged into output
- AC3.5 -> Unit test: missing additionalKey triggers console.warn
- AC3.6 -> Code review: `cdk-bootstrap-migrate.ts` uses `buildChildEnv()`
- AC3.7 -> Code review: `cdk-output.ts` uses `buildChildEnv()`
- AC3.8 -> Code review: `copy-lambda-artifacts.ts` uses `buildChildEnv()` for spawnSync
- AC3.9 -> Code review: `bundle-argon-2.ts` uses `buildChildEnv()` at both callsites

### AS-004 Tests

- AC4.1 -> Unit test: `:id` param with special chars returns 400
- AC4.2 -> Unit test: `validateRouteParam()` middleware rejects invalid values
- AC4.3 -> Code review: all listed routes have param validation

### AS-006 Tests

- AC6.1 -> Code review: all POST/PUT/PATCH handlers have Zod schema
- AC6.2 -> Code review: all bodies validated before processing
- AC6.3 -> Unit test: invalid body returns 400 with structured field-level errors

### AS-005 Tests

- AC5.1 -> Unit test: `ProcessConcurrencyLimiter` instantiates with acquire/release
- AC5.2 -> Unit test: custom `MAX_CONCURRENT_PROCESSES` changes max slots
- AC5.3 -> Unit test: acquire blocks when all slots full, resolves when released
- AC5.4 -> Unit test: release dequeues next waiter
- AC5.5 -> Unit test: acquire with timeout rejects after N ms
- AC5.6 -> Code review: async spawn/exec sites (bundle-argon-2.ts) wrapped with acquire/release
- AC5.7 -> Unit test: `_resetForTest()` clears all state
- AC5.8 -> Unit test: waiters served in FIFO order (first in, first out)

## Decision & Work Log

- 2026-02-20: Spec created from cross-repo analysis of ai-eng-dashboard security commits
- 2026-02-20: All five changes confirmed as independently implementable security hardening
- 2026-02-20: Codebase audit completed -- identified exact locations: 13 handlers with error leakage (~20+ mapper instances), 1 webhook middleware without size guard, 3 scripts with full env inheritance, multiple routes without param validation
- 2026-02-20: Decision -- Place `buildChildEnv()` in a shared location accessible to both `apps/` and `cdk/` scripts
- 2026-02-20: Decision -- Use `express.json({ limit })` as primary defense for AS-002 with webhook middleware as defense-in-depth
- 2026-02-23: ENFORCE FIX -- Split AS-004 into AS-004 (route param validation, AC4.1-AC4.3) and AS-006 (Zod body audit, AC6.1-AC6.3). AS-004 was TOO_COARSE with two independent behaviors.
- 2026-02-23: ENFORCE FIX -- Moved AC1.6 (rate-limit capacity bounds) from AS-001 to AS-002 (AC2.7). Both address DoS/resource exhaustion prevention. Updated to target only `dashboardRateLimiting.middleware.ts` since `ipRateLimiting.middleware.ts` uses DynamoDB (not in-memory).
- 2026-02-23: INVESTIGATE FIX -- Updated AS-001 to explicitly list `GitHubApiError` (502) and `GitHubAuthError` (401) as masking targets. Updated mapper count to ~20+ across 13 files.
- 2026-02-23: INVESTIGATE FIX -- Added AC3.9 to AS-003 for `bundle-argon-2.ts` (4th child_process callsite, lines 31/56).
- 2026-02-23: INVESTIGATE FIX -- Resolved `buildChildEnv()` location to `scripts/utils/child-env.mjs` (plain ESM, importable from both `apps/` and `cdk/`).
- 2026-02-23: INVESTIGATE FIX -- Updated AS-005 to clarify concurrency limiter only wraps async subprocess calls (currently only `bundle-argon-2.ts`). Synchronous CDK scripts are inherently sequential and do not need wrapping.
- 2026-02-23: INVESTIGATE FIX -- Updated AS-004 context to note `getUser.handler.ts` already has handler-level Zod validation via `GetUserSchema`; route-level middleware is defense-in-depth.
- 2026-02-23: Atomic spec count updated from 5 to 6.
