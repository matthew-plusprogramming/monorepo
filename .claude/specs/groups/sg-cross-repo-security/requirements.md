---
spec_group: sg-cross-repo-security
source: manual
last_updated: 2026-02-20
---

# Requirements

## Source

- **Origin**: Cross-repo analysis of ai-eng-dashboard commit history (security hardening)
- **Commits Analyzed**: `7de0eb9`, `939099f`, `1ac0139`
- **Extraction Date**: 2026-02-20

## Requirements

### REQ-001: Mask Internal Error Messages in API Responses

**Statement**: HTTP error responses must not expose raw `error.message` from caught exceptions. Internal details (stack traces, DB errors, file paths) must be replaced with generic messages. The real error must be logged server-side.

**EARS Format**:
- WHEN a handler catches an exception and returns an HTTP 500 response
- THEN the system shall return a generic message such as "Internal server error"
- AND the system shall NOT include the raw `error.message` from the caught exception in the response body
- AND the system shall log the real error via the logger service

- WHEN a handler returns an HTTP 4xx response for a user-facing error (validation, not found, etc.)
- THEN the system shall return a user-facing message describing the problem
- AND the system shall NOT include raw exception messages from internal operations

- WHEN the `generateRequestHandler` fallback error handler is invoked (no matching error type)
- THEN the system shall return a generic "Internal server error" message
- AND the system shall NOT send `error.message` directly in the response

- WHEN in-memory collections are used in server code (e.g., rate limit maps, event buffers)
- THEN the system shall enforce capacity bounds (MAX_EVENTS, MAX_ENTRIES) to prevent memory exhaustion

**Rationale**: Raw `error.message` values expose internal implementation details -- database error strings, file system paths, library versions -- which aid attackers in reconnaissance. The `generateRequestHandler` fallback on line 73 of `request.handler.ts` sends `error.message` directly.

**Source Commit**: `7de0eb9` (ai-eng-dashboard)

---

### REQ-002: Payload Size Guard Before HMAC Verification

**Statement**: Webhook endpoints must check request payload size before performing HMAC signature verification. This prevents CPU-based denial-of-service via oversized payloads that force expensive cryptographic computation.

**EARS Format**:
- WHEN a webhook request arrives at an HMAC-authenticated endpoint
- THEN the system shall check the Content-Length header before reading the body
- AND requests exceeding the maximum size (default 1MB) shall be rejected with HTTP 413 before HMAC verification

- WHEN a webhook request arrives without a Content-Length header
- THEN the system shall read the body with a streaming size limit
- AND the system shall abort reading if the size exceeds the maximum

- WHEN the maximum payload size needs to be configured
- THEN the system shall read from `MAX_WEBHOOK_PAYLOAD_BYTES` environment variable
- AND the system shall use 1MB (1048576 bytes) as the default if the variable is not set

**Rationale**: The current `webhookAuthMiddleware` in `apps/node-server/src/middleware/webhookAuth.middleware.ts` parses the full body via `JSON.stringify(req.body)` before signature verification. An attacker can send a multi-GB payload to force expensive HMAC computation.

**Source Commit**: `939099f` (ai-eng-dashboard)

---

### REQ-003: Minimal Environment Allowlist for Child Processes

**Statement**: When spawning child processes, the system must provide a minimal environment rather than inheriting the full parent environment. An allowlist determines which variables are passed through.

**EARS Format**:
- WHEN the system spawns a child process via `spawn()`, `exec()`, `execSync()`, or `fork()`
- THEN the system shall use `buildChildEnv()` to construct a minimal environment
- AND only allowlisted environment variables shall be passed to the child process

- WHEN `buildChildEnv()` is called
- THEN the default allowlist shall include: PATH, HOME, USER, SHELL, TERM, NODE_ENV, LOG_LEVEL
- AND all `CLAUDE_*` and `ANTHROPIC_*` variables shall be included
- AND additional variable names can be passed per-callsite via `additionalKeys` parameter

- WHEN a requested additional key is not present in `process.env`
- THEN the system shall log a warning identifying the missing variable

**Rationale**: Full environment inheritance leaks secrets, API keys, and internal configuration to subprocesses that may not need them. Scripts in `cdk/platform-cdk/scripts/` and `apps/node-server/scripts/` spawn child processes with `env: process.env`, passing the entire environment.

**Source Commit**: `1ac0139` (ai-eng-dashboard)

---

### REQ-004: Zod safeParse Audit on POST Endpoints

**Statement**: Every POST/PUT/PATCH endpoint must validate its request body with a Zod schema before processing. Route parameters containing user-supplied values must be validated with regex patterns.

**EARS Format**:
- WHEN a POST, PUT, or PATCH request is received by any handler
- THEN the system shall validate `req.body` against a Zod schema using `safeParse()` or the existing `parseInput()` helper
- AND failed validation shall return HTTP 400 with structured field-level error messages
- AND no internal error details shall be included in the validation error response

- WHEN a route parameter contains a user-supplied ID
- THEN the system shall validate the parameter against a regex pattern (e.g., `/^[a-zA-Z0-9_:-]{1,128}$/`)
- AND invalid parameters shall be rejected with HTTP 400 before reaching business logic

- WHEN request body validation is needed
- THEN a shared `validateBody(schema)` middleware or utility shall be available to DRY the pattern
- AND this utility shall be used consistently across all route files

**Rationale**: Some POST endpoints in the codebase accept `req.body` without Zod schema validation. The existing `parseInput()` helper at `apps/node-server/src/helpers/zodParser.ts` uses `.parse()` (throwing) rather than `.safeParse()`. Route parameter IDs (e.g., `:id` in `/api/spec-groups/:id`) are used without validation.

**Source Commit**: `7de0eb9` (ai-eng-dashboard)

---

### REQ-005: Concurrency Limiter for Subprocess Spawning

**Statement**: Subprocess spawning must be bounded by a concurrency limiter to prevent exhaustion of OS process limits, file descriptors, or memory.

**EARS Format**:
- WHEN code needs to spawn a subprocess
- THEN the system shall acquire a slot from `ProcessConcurrencyLimiter` before spawning
- AND release the slot after the subprocess completes (in a try/finally pattern)

- WHEN all concurrency slots are in use
- THEN `acquire()` shall return a promise that resolves when a slot becomes available
- AND waiters shall be served in FIFO order

- WHEN a configurable timeout elapses while waiting for a slot
- THEN `acquire()` shall reject with a timeout error to prevent deadlock

- WHEN the concurrency limit needs to be configured
- THEN the system shall read from `MAX_CONCURRENT_PROCESSES` environment variable
- AND the system shall use 5 as the default if the variable is not set

- WHEN tests need deterministic behavior
- THEN a `_resetForTest()` method shall be available to clear limiter state

**Rationale**: Unbounded subprocess spawning for agent invocations, builds, and deployments can exhaust OS process limits, file descriptors, or memory. No concurrency controls currently exist in the codebase.

**Source Commit**: `1ac0139` (ai-eng-dashboard)
