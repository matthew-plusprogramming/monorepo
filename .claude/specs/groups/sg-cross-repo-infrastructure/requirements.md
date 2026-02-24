# Requirements: Cross-Repo Infrastructure Improvements

## Problem Statement

The monorepo lacks several infrastructure capabilities that have been proven in the ai-eng-dashboard repository. These gaps create real operational risk:

1. **Logging**: The `LoggerService` in `packages/core/backend-core/src/services/logger.ts` is a bare Effect-TS tag with `log`, `logError`, `logDebug` -- no structured JSON output, no PII protection, no level filtering, no `logWarn` method.
2. **Request Tracing**: The monorepo's `node-server`, `analytics-lambda`, and `admin-portal` apps have no cross-service request tracing. Debugging request flows across services requires manual correlation.
3. **Deploy Safety**: The `scripts/cdk.mjs` deploy command has no freshness check. Deploying with stale `lambda.zip` after source changes is a proven class of deploy bug.
4. **Worktree Isolation**: The `manage-worktrees.mjs` script creates git worktrees but does not handle `.claude/` directory isolation -- worktrees get full state directories or none at all.

## Goals

- Port proven infrastructure from ai-eng-dashboard to the monorepo
- Each improvement is independently deployable and testable
- Backward compatibility with existing code is maintained
- Zero external dependency additions (use Node.js built-ins)

## Non-goals

- Replacing Effect-TS architecture (the structured logger supplements the existing `LoggerService`)
- Adding OpenTelemetry or distributed tracing SDKs
- Changing the CDK deployment tool chain (CDKTF stays)
- Modifying the git worktree creation logic itself

## Requirements

### Structured JSON Logger with PII Redaction

- **REQ-001**: **WHEN** a service needs structured logging, **THEN** a `createStructuredLogger(config)` factory shall produce a logger that outputs single-line JSON to stdout via `process.stdout.write`.
- **REQ-002**: **WHEN** log context objects contain fields matching the `SENSITIVE_KEYS` set (email, phone, ssn, password, token, secret, key, authorization, cookie, session, credit_card, address, dob, and variants), **THEN** the logger shall recursively replace their values with `'[REDACTED]'` before serialization.
- **REQ-003**: **WHEN** the `LOG_LEVEL` environment variable is set, **THEN** log entries below that level shall be suppressed; **WHEN** `LOG_LEVEL` is unset but `DEBUG=true`, **THEN** the level shall default to DEBUG; **WHEN** neither is set, **THEN** the level shall default to INFO.
- **REQ-004**: **WHEN** a serialized log entry exceeds `MAX_LOG_ENTRY_SIZE` (8192 characters), **THEN** the entry shall be truncated and include a `[TRUNCATED]` marker in the message field.
- **REQ-005**: **WHEN** log context contains circular references, **THEN** the logger shall not crash and shall use a WeakSet-based cycle detector to produce a fallback entry.
- **REQ-006**: **WHEN** caller context includes fields named `timestamp`, `level`, `service`, or `component`, **THEN** those fields shall NOT override the base entry fields (security invariant).
- **REQ-007**: **WHEN** the `LoggerService` interface is used by existing callers, **THEN** backward compatibility shall be maintained; **AND** a `logWarn` method shall be added to the interface.

### Correlation Context via AsyncLocalStorage

- **REQ-008**: **WHEN** a request enters the system, **THEN** `runWithCorrelation(store, fn)` shall establish an `AsyncLocalStorage` context containing `requestId`, `correlationId`, and optional `jobId`/`workflowId` fields.
- **REQ-009**: **WHEN** code runs within a correlation context, **THEN** `getCorrelation()` shall return the current `CorrelationStore`; **WHEN** code runs outside any context, **THEN** it shall return `undefined` without error.
- **REQ-010**: **WHEN** `getCorrelationHeaders()` is called within a correlation context, **THEN** it shall return a `Record<string, string>` mapping `requestId` to `x-request-id` and `correlationId` to `x-correlation-id`.
- **REQ-011**: **WHEN** `correlatedFetch(url, init?)` is called within a correlation context, **THEN** it shall inject `x-request-id` and `x-correlation-id` headers into the outgoing request; **AND** caller-provided headers shall override correlation headers on conflict.
- **REQ-012**: **WHEN** a correlation ID is received at an ingest boundary (HTTP header, queue message), **THEN** it shall be validated against the pattern `^[a-zA-Z0-9._-]{1,128}$` before being stored.
- **REQ-013**: The correlation context module shall have zero external dependencies (only `node:async_hooks`).

### Stale Artifact Detection for Deploys

- **REQ-014**: **WHEN** `getNewestFileInDir(dir)` traverses a directory tree, **THEN** it shall return the path and mtime of the most recently modified file; **AND** it shall protect against symlink loops using a visited Set.
- **REQ-015**: **WHEN** `checkArtifactFreshness(artifactPath, sourceDirs, thresholdMs)` is called, **THEN** it shall compare the artifact's mtime against the newest source file mtime and return stale/fresh status with a time delta.
- **REQ-016**: **WHEN** `scripts/cdk.mjs deploy` is invoked, **THEN** it shall check artifact freshness before deploying; **WHEN** a stale artifact is detected, **THEN** it shall block the deploy with a clear error message showing artifact timestamp vs source timestamp.
- **REQ-017**: **WHEN** `--acknowledge-stale` flag is provided, **THEN** the freshness check shall be bypassed; **WHEN** `--force` flag is provided without `--acknowledge-stale`, **THEN** freshness shall still be checked (intentional design -- `--force` skips validation, not freshness).
- **REQ-018**: The `ARTIFACT_SOURCE_DIRS` map shall be configured for the monorepo's actual artifact-to-source directory mappings (e.g., `lambdas/api/lambda.zip` -> `apps/node-server/src`, `packages/core/backend-core/src`).

### Selective .claude/ Copy for Worktrees

- **REQ-019**: **WHEN** a worktree is created via `manage-worktrees.mjs`, **THEN** `selective-claude-copy.mjs` shall copy only operational `.claude/` items: `skills/`, `agents/`, `templates/`, `scripts/`, `schemas/`, `specs/schema/`, `settings.json`.
- **REQ-020**: **WHEN** `.claude/` is copied to a worktree, **THEN** state directories shall be excluded: `specs/groups/`, `context/`, `memory-bank/`, `journal/`, `docs/`, `specs/archive/`, `contracts/`.
- **REQ-021**: **WHEN** a branch name follows the pattern `sg-<feature-name>/<action>`, **THEN** `extractSpecGroupId()` shall return the spec group ID (e.g., `sg-auth-system`); **WHEN** the branch name does not match, **THEN** it shall return `null`.
- **REQ-022**: **WHEN** worktrees are created with selective `.claude/` copy, **THEN** Claude Code shall be able to run with full skill/agent access but no state pollution from the parent repo.

## Constraints

- All new code must be TypeScript (for `packages/core`) or ESM JavaScript (for `scripts/`)
- No new npm dependencies for AS-001 through AS-003; AS-004 uses only Node.js built-ins
- Existing `LoggerService` callers must not break
- The `scripts/cdk.mjs` command interface must remain backward compatible (new flags only)

## Priority

| Requirement | Priority  | Rationale                                    |
| ----------- | --------- | -------------------------------------------- |
| REQ-001-007 | Must Have | PII exposure risk, operational observability  |
| REQ-008-013 | Must Have | Cross-service debugging capability           |
| REQ-014-018 | Must Have | Prevents stale artifact deploy bugs          |
| REQ-019-022 | Should Have | Worktree workflow improvement               |

## Open Questions

- Q1: Should AS-001 structured logger be wired as the default implementation of the Effect-TS `LoggerService` tag, or exist as a standalone utility that callers can choose? (Status: open, Recommendation: standalone utility with adapter)
- Q2: Should AS-002 include Express middleware out of the box or just export the primitives? (Status: open, Recommendation: primitives only, middleware in a follow-up)
