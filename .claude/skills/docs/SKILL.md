---
name: docs
description: Generate documentation from implementation. Creates user docs, API docs, and architecture docs. HIGHLY RECOMMENDED for substantial changes, especially public APIs.
allowed-tools: Read, Write, Glob, Grep
---

# Documentation Skill

## Purpose

Generate documentation artifacts from implemented code. Create durable external context that survives beyond the current session.

## When to Use

### Highly Recommended (Should Use)

- **Public API additions**: New endpoints, methods, or interfaces
- **User-facing features**: Features end users will interact with
- **Substantial changes**: Multi-file implementations, new services
- **Complex logic**: Non-obvious algorithms or workflows
- **Configuration options**: New environment variables or settings

### Optional

- Internal refactoring (no API changes)
- Bug fixes (unless they change documented behavior)
- Test-only changes
- Minor UI tweaks

### Skip

- Documentation-only changes (already documented)
- Trivial single-line fixes

## Documentation Types

### API Documentation

For public endpoints and methods:

```markdown
## methodName

Brief description of what it does.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| param1 | string | Yes | What this parameter controls |

### Returns

`ReturnType` - Description of return value

### Errors

| Error | When |
|-------|------|
| InvalidInputError | When param1 is empty |

### Example

\`\`\`typescript
const result = await service.methodName('value');
\`\`\`
```

### User Guides

For user-facing features:

```markdown
## Feature Name

What this feature does and why you'd use it.

### Getting Started

Step-by-step instructions for basic usage.

### Configuration

Available options and what they control.

### Examples

Common use cases with code/UI examples.

### Troubleshooting

Common issues and how to resolve them.
```

### Architecture Documentation

For complex systems:

```markdown
## Component Name

### Purpose

Why this component exists and what problem it solves.

### Design Decisions

Key decisions and their rationale.

### Data Flow

How data moves through the component.

### Dependencies

What this component depends on and why.
```

## Documentation Process

### Step 1: Identify Scope

```bash
# Check what was implemented
cat .claude/specs/active/<slug>.md

# Find modified files
git diff --name-only main..HEAD

# Identify public interfaces
grep -r "export" src/ --include="*.ts" | grep -E "(class|interface|function|const)"
```

Determine documentation needs:
- Public APIs → API docs (always)
- User-facing features → User guides (always)
- Internal architecture → Architecture docs (if complex)
- Configuration → Configuration docs (always)

### Step 2: Read Implementation (Not Spec)

**Critical**: Document what the code DOES, not what the spec SAYS.

```bash
# Read actual implementation
cat src/services/feature.ts

# Check for edge cases in tests
cat src/services/__tests__/feature.test.ts

# Look for error handling
grep -A5 "catch\|throw\|Error" src/services/feature.ts
```

### Step 3: Generate Documentation

Follow documentation standards:

#### DO:
- Use present tense ("Returns" not "Will return")
- Include working code examples
- Document error conditions
- Link to related documentation
- Keep examples minimal but complete

#### DON'T:
- Copy spec language verbatim
- Document internal implementation details in user docs
- Assume reader knows the codebase
- Leave placeholder text ("TODO", "TBD")
- Over-document obvious things

### Step 4: Place Documentation

```
docs/
├── api/                 # API reference
│   └── services/
│       └── auth.md
├── guides/              # User guides
│   └── authentication.md
├── architecture/        # Internal architecture
│   └── auth-system.md
└── README.md            # Project overview
```

For inline documentation:
- JSDoc for public APIs
- README.md in package roots
- CHANGELOG.md for version history

### Step 5: Validate

```bash
# Check code examples compile (if applicable)
npx tsc --noEmit docs/examples/*.ts

# Ensure consistent formatting
npx prettier --check docs/**/*.md
```

### Step 6: Update Spec Status

```yaml
---
documentation_status: complete
---
```

Add documentation log:

```markdown
## Documentation Log

- 2026-01-08: Documentation complete
  - API docs: docs/api/services/auth.md
  - User guide: docs/guides/authentication.md
  - Examples verified: 3 code samples tested
```

## Documentation Standards

### Code Examples Must Work

Every code example must:
1. Be syntactically correct
2. Use real types/imports from the codebase
3. Demonstrate the happy path
4. Be copy-paste runnable (with minimal setup)

**Bad**:
```typescript
const result = doThing(params); // params undefined
```

**Good**:
```typescript
import { AuthService } from '@/services/auth';

const authService = new AuthService();
const result = await authService.logout();
// result: { success: true }
```

### Document Behavior, Not Implementation

**Bad** (leaks implementation):
```markdown
The logout method clears the localStorage key 'auth_token'
and sets the BehaviorSubject to false.
```

**Good** (describes behavior):
```markdown
The logout method ends the current session and redirects
to the login page. Any cached credentials are cleared.
```

### Match Audience to Doc Type

| Doc Type | Audience | Tone | Detail Level |
|----------|----------|------|--------------|
| API Reference | Developers | Technical, precise | High |
| User Guide | End users | Friendly, task-focused | Medium |
| Architecture | Future maintainers | Explanatory | High |

## Output Format

```markdown
## Documentation Complete

**Spec**: .claude/specs/active/<slug>.md

**Artifacts Created**:
- docs/api/services/auth.md (API reference)
- docs/guides/authentication.md (user guide)

**Coverage**:
- Public methods documented: 5/5
- Examples included: 3
- Error conditions documented: 4

**Validation**:
- Code examples: verified
- Links: verified
- Formatting: consistent
```

## Integration with Other Skills

**Before docs**:
- `/security` review passed

**After docs**:
- Ready for commit/merge

Documentation is typically the final step before commit for substantial changes.

## Constraints

### Read Implementation, Not Just Spec

The spec says what SHOULD happen. The code says what DOES happen. Document reality.

### No Code Changes

You generate documentation only. If you find:
- Undocumented public APIs → Document them
- Bugs in implementation → Note in report, don't fix
- Missing error handling → Document current behavior, note gap

### Consistency Over Creativity

Match existing documentation style in the project. Follow established patterns.

## Examples

### Example 1: API Documentation

**Input**: New logout endpoint implementation

**Output**:
```markdown
# AuthService.logout()

Terminates the current user session and clears authentication state.

## Signature

\`\`\`typescript
async logout(): Promise<void>
\`\`\`

## Behavior

1. Calls server to invalidate session
2. Clears local authentication token
3. Updates auth state to unauthenticated
4. Triggers redirect to login page

## Errors

| Error | Cause |
|-------|-------|
| `NetworkError` | Cannot reach server |
| `LogoutError` | Server rejected logout |

## Example

\`\`\`typescript
import { authService } from '@/services/auth';

try {
  await authService.logout();
  // User is now logged out, redirect handled automatically
} catch (error) {
  if (error instanceof NetworkError) {
    showToast('Check your connection and try again');
  }
}
\`\`\`
```

### Example 2: User Guide

**Input**: New dashboard feature

**Output**:
```markdown
# Using the Dashboard

The dashboard provides an overview of your daily tasks and priorities.

## Getting Started

1. Log in to your account
2. Click "Dashboard" in the navigation menu
3. Your daily briefing appears automatically

## Features

### Daily Briefing
Shows your priorities for today, including:
- Urgent emails requiring response
- Upcoming calendar events
- Tasks due today

### Quick Actions
- **Snooze**: Postpone an item to later
- **Complete**: Mark a task as done
- **Delegate**: Assign to someone else

## Customization

Access Settings → Dashboard to configure:
- Briefing time (default: 9:00 AM)
- Priority thresholds
- Notification preferences
```

### Example 3: Architecture Doc

**Input**: New notification service

**Output**:
```markdown
# Notification Service Architecture

## Purpose

Centralizes all user notifications across channels (email, SMS, push).

## Design Decisions

**Why a separate service?**
- Decouples notification logic from business logic
- Enables channel-agnostic notification requests
- Supports future channels without core changes

**Why queue-based?**
- Handles burst traffic gracefully
- Enables retry logic for failed deliveries
- Provides delivery tracking

## Data Flow

\`\`\`
Business Logic → NotificationService.send()
                         ↓
                   Queue (Redis)
                         ↓
              Channel Adapters (Email, SMS, Push)
                         ↓
                 Delivery Status → Database
\`\`\`

## Dependencies

- **Redis**: Message queue
- **Telnyx**: SMS delivery
- **SendGrid**: Email delivery
- **Firebase**: Push notifications
```
