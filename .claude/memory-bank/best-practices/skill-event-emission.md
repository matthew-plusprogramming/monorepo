# Skill Event Emission Pattern

Skills emit lifecycle events to enable dashboard integration and workflow automation.

## Event Schema

Events follow `.claude/schemas/skill-event.schema.json`:

```json
{
  "event_type": "spec.approved",
  "skill": "spec",
  "timestamp": "2024-01-15T10:30:00Z",
  "spec_group_id": "sg-auth-system",
  "payload": {
    "spec_path": ".claude/specs/groups/sg-auth-system/spec.md",
    "approver": "user"
  }
}
```

## Standard Event Types

### Spec Lifecycle

- `spec.created` - New spec authored
- `spec.updated` - Spec modified
- `spec.approved` - Spec approved for implementation
- `spec.rejected` - Spec rejected, needs revision

### Implementation Lifecycle

- `implementation.started` - Work begun on atomic spec
- `implementation.completed` - Atomic spec implemented
- `implementation.blocked` - Implementation hit blocker

### Test Lifecycle

- `test.written` - Tests created for AC
- `test.passed` - All tests passing
- `test.failed` - Test failure detected

### Review Lifecycle

- `review.requested` - Review requested
- `review.completed` - Review finished
- `review.finding` - Individual finding reported

### Convergence

- `convergence.checked` - Unifier ran
- `convergence.passed` - Spec-impl-test aligned
- `convergence.failed` - Alignment issues found

## Emission Pattern

Skills emit events by writing to `.claude/events/pending/`:

```
.claude/events/
├── pending/           # Unprocessed events
│   └── {timestamp}-{event_type}.json
└── processed/         # Archived events
    └── {date}/
        └── {timestamp}-{event_type}.json
```

## Implementation Notes

1. Events are fire-and-forget from skill perspective
2. Event processor (when implemented) moves from pending to processed
3. Dashboard polls pending directory or subscribes to processor
4. Events include enough context to be self-describing
5. Payload is event-type-specific, schema is extensible

## Future Integration

When S-DLC message queue is active:

- Events publish to queue instead of filesystem
- Dashboard subscribes to queue
- Same event schema, different transport
