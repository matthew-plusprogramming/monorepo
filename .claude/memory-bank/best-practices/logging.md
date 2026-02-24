---
domain: observability
tags: [logging, structured-logs, debugging, tracing, observability]
last_reviewed: 2026-02-15
---

# Log Design Best Practices (AI-Friendly & Debuggable)

## Structured Logs

- Emit JSON events with a stable schema.
- Include standard fields: `timestamp`, `service`, `component`, `env`, `version`, `level`, `event_type`, `duration_ms`.

## Correlation Identifiers

- Always log: `trace_id`, `span_id`, `request_id` (or `job_id` / `workflow_id`).
- Ensure all services propagate these IDs across boundaries.

## Explicit Semantics

- Define consistent `event_type` values (e.g., `request_started`, `db_query`, `retry`, `invariant_failed`).
- Use enumerated `error_code` and `error_kind` fields instead of free-text errors.

## Causality and Lifecycle

- Include `phase` or workflow stage (e.g., `auth`, `routing`, `db_write`, `respond`).
- Record start/end events and key state transitions.

## High-Signal Context

- Log IDs, hashes, counts, and **state deltas** instead of full payload dumps.
- Record dependency metadata (upstream service, DB cluster, region).

## Standardized Error Handling

- Attach `error_code`, `blame` (self/upstream/client), and `retry_safe` hints.
- Always log invariant or contract violations explicitly.

## Volume Control

- Sample successes; always retain failures.
- Enable debug-level burst logging around slow or failed requests.

## Logging Contract

- Document the log schema, event types, correlation IDs, and error taxonomy.
- Provide canonical queries/views: request timeline, error rollups, slow paths, dependency failures.

## Core Principle

Design logs so a system (human or AI) can reconstruct **what happened, in what order, why it failed, and where to look next** without relying on free-text interpretation.

## Cross-References

- For structured error handling patterns, see `code-quality.md`.
- For error code and blame attribution patterns, see `software-principles.md`.
- For wire protocol contracts (which logs should trace), see `contract-first.md`.
