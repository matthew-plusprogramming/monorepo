# Logging Checklist

Design logs so a system (human or AI) can reconstruct what happened, in what order, why it failed, and where to look next — without relying on free-text interpretation.

## Structured Logs

- Emit JSON events with a stable schema
- Standard fields: `timestamp`, `service`, `component`, `env`, `version`, `level`, `event_type`, `duration_ms`

## Correlation Identifiers

- Always include: `trace_id`, `span_id`, `request_id` (or `job_id` / `workflow_id`)
- Propagate IDs across all service boundaries

## Explicit Semantics

- Define consistent `event_type` values (e.g., `request_started`, `db_query`, `retry`, `invariant_failed`)
- Use enumerated `error_code` and `error_kind` fields instead of free-text errors

## Causality and Lifecycle

- Include `phase` or workflow stage (e.g., `auth`, `routing`, `db_write`, `respond`)
- Record start/end events and key state transitions

## High-Signal Context

- Log IDs, hashes, counts, and state deltas — not full payload dumps
- Record dependency metadata (upstream service, DB cluster, region)

## Volume Control

- Sample successes; always retain failures
- Enable debug-level burst logging around slow or failed requests
