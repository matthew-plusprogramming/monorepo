---
last_reviewed: 2026-02-14
---

# EARS Format for Requirements

EARS (Easy Approach to Requirements Syntax) provides templates for writing unambiguous requirements.

## Pattern Types

### Ubiquitous (always active)

**Template**: "The [system] shall [action]"
**Example**: "The API shall validate all input parameters"
**Use when**: Requirement applies unconditionally

### Event-Driven (triggered by event)

**Template**: "When [trigger], the [system] shall [action]"
**Example**: "When authentication fails 3 times, the system shall lock the account"
**Use when**: Requirement activates on specific event

### State-Driven (active during state)

**Template**: "While [state], the [system] shall [action]"
**Example**: "While in maintenance mode, the system shall reject write operations"
**Use when**: Requirement applies only during specific state

### Optional/Conditional

**Template**: "Where [condition], the [system] shall [action]"
**Example**: "Where PII is detected, the system shall apply encryption"
**Use when**: Requirement applies only under certain conditions

### Complex (if-then-else)

**Template**: "If [condition] then [system] shall [action], otherwise [system] shall [alternative]"
**Example**: "If user has admin role then system shall grant full access, otherwise system shall grant read-only access"
**Use when**: Requirement has branching behavior

## Security Requirements Examples

### Authentication

- "The system shall authenticate all API requests using JWT tokens"
- "When a JWT token expires, the system shall reject the request with 401 status"
- "Where refresh tokens are used, the system shall rotate them on each use"

### Authorization

- "The system shall enforce role-based access control on all endpoints"
- "While a user session is active, the system shall validate permissions on each request"

### Data Protection

- "The system shall encrypt all PII at rest using AES-256"
- "When transmitting sensitive data, the system shall use TLS 1.3"

## Writing Tips

1. One requirement per statement
2. Use precise, measurable language
3. Avoid ambiguous terms (appropriate, sufficient, etc.)
4. Reference specific standards where applicable
5. Make requirements testable
