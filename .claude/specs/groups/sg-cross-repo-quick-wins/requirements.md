---
spec_group: sg-cross-repo-quick-wins
source: manual
last_updated: 2026-02-20
---

# Requirements

## Source

- **Origin**: Cross-repo analysis of ai-eng-dashboard commit history
- **Commits Analyzed**: `24343d6`, `d89d2d4`, `939099f`
- **Extraction Date**: 2026-02-20

## Requirements

### REQ-001: Exclude session.json from Git Tracking

**Statement**: `.claude/context/session.json` must be excluded from git tracking to prevent noise in `git status`.

**EARS Format**:
- WHEN a developer runs `git status`
- THE SYSTEM SHALL NOT show `.claude/context/session.json` as modified
- AND the file shall be listed in `.gitignore`
- AND the file shall be removed from git's index if currently tracked

**Rationale**: This file changes every Claude Code session and creates unnecessary noise in version control diffs.

**Source Commit**: `24343d6` (ai-eng-dashboard)

---

### REQ-002: URL-Encode Dynamic Path Segments in Client API

**Statement**: All dynamic values interpolated into URL paths in client-side API calls must be encoded with `encodeURIComponent()`.

**EARS Format**:
- WHEN a client-side API function constructs a URL with dynamic path segments
- THE SYSTEM SHALL wrap each dynamic segment in `encodeURIComponent()`
- AND this shall apply to ALL files in `apps/client-website/src/lib/api/`
- AND IDs containing special characters (`/`, `?`, `#`, `%`) shall be safely encoded

**Rationale**: Unencoded dynamic values allow path traversal or URL corruption when IDs contain special characters.

**Source Commit**: `d89d2d4` (ai-eng-dashboard)

---

### REQ-003: Validate DynamoDB Status Fields Against Allowlist

**Statement**: Raw DynamoDB status/state values must be validated against an allowlist before use, replacing unsafe `as` type casts.

**EARS Format**:
- WHEN a repository function reads a status-like field from DynamoDB
- THE SYSTEM SHALL validate the raw value against a `VALID_STATUSES` (or `VALID_STATES`) const array
- AND fall back to a safe default value if the raw value is not in the allowlist
- AND remove the `as` type cast in favor of runtime validation
- AND this pattern shall apply to ALL repository files in `packages/core/backend-core/src/`

**Rationale**: Using `as` casts on raw DynamoDB values allows arbitrary strings to propagate as typed values, bypassing TypeScript's type safety at the data boundary.

**Source Commit**: `d89d2d4` (ai-eng-dashboard)

---

### REQ-004: Use crypto.randomUUID() for ID Generation

**Statement**: Server-side ID generation must use `crypto.randomUUID()` instead of `Math.random()` based approaches.

**EARS Format**:
- WHEN server-side code generates a unique identifier
- THE SYSTEM SHALL use `randomUUID` imported from `node:crypto`
- AND all instances of `Math.random().toString(36)` (or similar patterns) in server-side code shall be replaced
- AND client-side code shall NOT be modified (browser `crypto.randomUUID()` has different availability)

**Rationale**: `Math.random()` is not cryptographically secure and produces short, predictable values unsuitable for identifiers.

**Source Commit**: `939099f` (ai-eng-dashboard)
