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

## Silent-Drop Observability

Silent drops in broadcast, fan-out, and delivery paths (bare `continue`/`return`/unmatched switch) produced 6 of 11 Context Engine postmortem bugs (55%). This section documents the anti-pattern, the observable-drop substitution, the delivery-path taxonomy, and the external-observer litmus test so the pattern becomes unreviewable (and, over time, unwritable). See `.claude/prds/silent-drop-observability/prd.md` for context.

### External observer definition

**External observer: any system or party capable of detecting the non-delivery outside the calling function's process boundary.** External observers include: log aggregators, metrics backends, client-facing error responses, and user-visible UI state. **NOT external observers**: in-process variables, stack locals, comments, commit messages, or any signal the next function call up the stack cannot observe.

### Litmus test

> **Would any external observer know?** If this path drops the message, will any external observer (log, metric, client error, UI state) know it was dropped? If the answer is "no", the drop is silent — flag it.

### Anti-pattern (silent drop)

Code in a delivery path silently discards a message via a bare `continue`, `return`, or unmatched `switch`/`case` with no exception, log, or metric. The system appears healthy while silently failing its reason to exist.

```ts
// BAD — bare continue, no observer knows the drop happened.
for (const client of clients) {
  if (!client.isActive) {
    continue;
  }
  client.send(event);
}

// BAD — unmatched switch, no default log/metric.
switch (event.type) {
  case 'a':
    handleA(event);
    break;
  case 'b':
    handleB(event);
    break;
}

// BAD — early return, no observer.
function deliverToClient(client, event) {
  if (client.state !== 'ready') return;
  client.send(event);
}
```

### Observable-drop substitution

Pair the drop with a structured log at minimum; for high-volume paths, add a metric counter. Both name the `reason` as a closed-enum value defined in code — never a free-form string.

```ts
// GOOD — structured log + optional metric; both name a closed-enum reason.
for (const client of clients) {
  if (!client.isActive) {
    logger.warn('client_delivery_skipped', {
      reason: 'client_inactive', // closed-enum
      client_id_hash: hash(client.id),
    });
    metrics.counter('broadcast.client_send.dropped', {
      reason: 'client_inactive', // same closed-enum
    });
    continue;
  }
  client.send(event);
}

// GOOD — default branch names and observes the unknown event class.
switch (event.type) {
  case 'a':
    handleA(event);
    break;
  case 'b':
    handleB(event);
    break;
  default:
    logger.warn('router_unknown_event', {
      event_type_bucket: bucket(event.type),
    });
    metrics.counter('router.dispatch.dropped', {
      reason: 'unknown_event_type',
    });
}
```

### Delivery-path module categories (taxonomy)

The following seven categories are delivery-path modules for the purposes of this checklist. Extension of the taxonomy happens via edit to this file — not via PRD or agent-instruction edit.

1. **WS broadcasts** — WebSocket server emitting events to many subscribers.
2. **SSE** — Server-Sent Events streams; per-client write loops.
3. **Emitter fan-out** — `EventEmitter`-style dispatch to registered listeners.
4. **Pub/sub** — message-bus publish/subscribe routers.
5. **Queue consumers** — workers pulling from a queue and invoking per-message handlers.
6. **Frontend event routers** — in-browser routers dispatching user or network events to handlers.
7. **REST handler routers** — server-side switches selecting handler by route, method, or card type.

**Explicit exclusions** (NOT delivery-path modules for this pattern): direct RPC / request-response (caller sees the error), pure-compute reducers, and data-access-layer errors (covered by error-handling best practices).

### Metric naming convention

Delivery-path drop counters follow `<component>.<path>.dropped` with a closed-enum `reason` label. Cardinality is bounded:

- **≤20 reason values** per counter (closed enum defined in code, not free-form).
- **≤5 other labels** total.
- **No per-client, per-user, or per-request labels** (`client_id`, `user_id`, `request_id` etc. explode cardinality and leak PII).

Code-reviewer emits a Category H.3 finding when any cardinality cap is violated:

- `metric-naming-violation` — flat `dropped` (no `<component>.<path>.` hierarchy).
- `label-cardinality` — per-client label, >5 label keys, or >20 reason enum values.
- `free-form-reason` — reason is a string expression, not a code-defined enum value.
- `sensitive-reason-value` — reason value matches PII heuristics (user ID pattern, token fragment, IP address, email, query string, auth header).

**Reason enum values MUST be non-sensitive identifiers.** No user IDs, token fragments, IP addresses, emails, query strings, or auth headers. `function_name` in advisory-suspect records is truncated to 40 characters.

### Health-endpoint exemption (cross-PRD)

Flat top-level counters named `delivered` and `dropped` emitted by a health-endpoint route handler (e.g., `/health`, `/metrics`) are exempt from `metric-naming-violation`. This aligns with `pipeline-integration-gaps` SC-10, which mandates flat top-level names for the broadcast health endpoint. Detection:

- File path matches the health-endpoint route module, AND
- Counter name ∈ `{delivered, dropped}` at top level (no component prefix).

The exemption is applied at AC level; it does not wait on any amendment SLA. See `.claude/prds/pipeline-integration-gaps/prd.md` SC-10.

### Logging-only exception (low-volume paths)

Metrics are SHOULD (not MUST) for high-volume paths. Low-volume paths — CLIs, admin scripts, one-shot jobs, single-operator tools — MAY run in logging-only mode. A structured `logger.warn('skipped', { reason })` call at the drop site satisfies the observable-drop requirement for these modules. No metric counter is required. The author SHOULD note the logging-only choice in a code comment or PR description.

### Acknowledgment annotations

A reviewer suppression annotation MAY be used when a drop is genuinely safe (idempotent replay, unreachable branch). Annotations have the form:

```ts
// silent-drop: safe — <rationale ≥15 chars explaining why the drop is observer-unnecessary>
```

**Audit constraints** (enforced by code-reviewer):

- `rationale ≥15 plain-text characters`.
- Per-PR cap = `max(5, 1 per 10 delivery-path files touched)`; exceeding the cap emits `annotation-overuse` (Medium).
- Annotation with git-blame author-timestamp > 90 days without refresh emits `annotation-stale` (Medium).
- Code-reviewer records each annotation in `annotations_used[]` as `{file, line, suppressed, rationale_prefix}` where `rationale_prefix` is the first 40 plain-text characters.

### Summary

- **Anti-pattern**: bare `continue`/`return`/unmatched switch in a delivery-path function body.
- **Substitution**: structured log (always) + metric counter (for high-volume paths).
- **Naming**: `<component>.<path>.dropped` with closed-enum `reason`, ≤20 reasons, ≤5 labels.
- **Litmus**: would any external observer know?
- **Taxonomy**: 7 delivery-path categories, extensible via edit to this file.
- **Review**: Category H (H.1 skip-path-has-log, H.2 high-volume-also-has-metric, H.3 metric-naming-and-cardinality) in `.claude/agents/code-reviewer.md`.
