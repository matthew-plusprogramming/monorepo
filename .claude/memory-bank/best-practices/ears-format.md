# EARS Requirement Patterns

EARS (Easy Approach to Requirements Syntax) — use these templates for unambiguous, testable requirements.

## Ubiquitous (always active)

**Template**: "The [system] shall [action]"
**Example**: "The API shall validate all input parameters"

## Event-Driven (triggered by event)

**Template**: "When [trigger], the [system] shall [action]"
**Example**: "When authentication fails 3 times, the system shall lock the account"

## State-Driven (active during state)

**Template**: "While [state], the [system] shall [action]"
**Example**: "While in maintenance mode, the system shall reject write operations"

## Optional/Conditional

**Template**: "Where [condition], the [system] shall [action]"
**Example**: "Where PII is detected, the system shall apply encryption"

## Complex (if-then-else)

**Template**: "If [condition] then [system] shall [action], otherwise [system] shall [alternative]"
**Example**: "If user has admin role then system shall grant full access, otherwise system shall grant read-only access"
