# Auto-Decision Audit Log

## Metadata

- **Spec Group**: {{ spec_group_id }}
- **Loop Type**: {{ loop_type }} (investigation | challenger)
- **Loop Run ID**: {{ loop_run_id }}
- **Started At**: {{ started_at }}
- **Circuit Breaker State**: {{ circuit_breaker_state }} (enabled | disabled)

## Entries

<!-- Append-only: Do not modify existing entries. Sequential entry IDs enable gap detection for corruption/truncation. -->

| Entry ID       | Finding ID       | Action       | Confidence       | Escalation Reason       | Timestamp       | Criterion 1 (Verb) | Criterion 2 (Ref) | Criterion 3 (Confidence) |
| -------------- | ---------------- | ------------ | ---------------- | ----------------------- | --------------- | ------------------ | ----------------- | ------------------------ |
| {{ entry_id }} | {{ finding_id }} | {{ action }} | {{ confidence }} | {{ escalation_reason }} | {{ timestamp }} | {{ criterion_1 }}  | {{ criterion_2 }} | {{ criterion_3 }}        |

## Override Events

<!-- Human override events are counted toward circuit breaker accuracy computation. -->

| Finding ID       | Override Timestamp |
| ---------------- | ------------------ |
| {{ finding_id }} | {{ timestamp }}    |

## Circuit Breaker History

<!-- Accuracy = 1 - (overrides / total_auto_accepts) over rolling 10-cycle window. Disable < 90%, re-enable > 95%. -->

| Timestamp       | State       | Accuracy       | Total Auto-Accepts       | Override Count       |
| --------------- | ----------- | -------------- | ------------------------ | -------------------- |
| {{ timestamp }} | {{ state }} | {{ accuracy }} | {{ total_auto_accepts }} | {{ override_count }} |
