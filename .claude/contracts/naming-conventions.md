# Naming Conventions

Consistent naming prevents integration failures caused by mismatched identifiers across parallel agents. This file is the single source of truth for naming patterns across all four contract types.

**Precedence rule**: New code follows these conventions. Existing code follows legacy conventions until refactored. When in doubt, match the existing pattern in the file you are modifying.

---

## REST API Endpoints

**Pattern**: `kebab-case` paths with path-based versioning.

| Rule              | Pattern                                      | Example                           |
| ----------------- | -------------------------------------------- | --------------------------------- |
| Base path         | `/api/v{n}/...`                              | `/api/v1/users`                   |
| Resource (plural) | `/api/v{n}/{resources}`                      | `/api/v1/sessions`                |
| Resource instance | `/api/v{n}/{resources}/{id}`                 | `/api/v1/sessions/abc-123`        |
| Sub-resource      | `/api/v{n}/{resources}/{id}/{sub-resources}` | `/api/v1/users/123/sessions`      |
| Action (non-CRUD) | `/api/v{n}/{resources}/{id}/{action}`        | `/api/v1/sessions/abc-123/revoke` |
| Query filters     | `?snake_case=value`                          | `?created_after=2026-01-01`       |

**Versioning**: Path-based API versioning (`/api/v1/`, `/api/v2/`) is the sole versioning strategy. Do not use header-based or query-parameter-based versioning.

**Conventions**:

- Use plural nouns for collections (`/users`, not `/user`)
- Use kebab-case for multi-word paths (`/user-sessions`, not `/userSessions`)
- Avoid deep nesting beyond 3 levels
- Use HTTP methods to convey action (GET, POST, PUT, PATCH, DELETE)

---

## Event Names

**Pattern**: `dot-separated`, lowercase: `resource.action`.

| Rule         | Pattern                        | Example                |
| ------------ | ------------------------------ | ---------------------- |
| Simple event | `{resource}.{action}`          | `session.created`      |
| Scoped event | `{domain}.{resource}.{action}` | `auth.session.created` |
| State change | `{resource}.{past-tense-verb}` | `user.deactivated`     |
| Lifecycle    | `{resource}.{lifecycle-stage}` | `deployment.started`   |

**Conventions**:

- Use past tense for completed events (`created`, not `create`)
- Use present tense for in-progress events (`processing`, not `processed`)
- Avoid prefixes that duplicate channel information (if channel is `/events/auth`, event name does not need `auth.` prefix)
- Keep event names stable -- renaming an event is a breaking change

---

## Data Model Fields

**Pattern**: `snake_case` for database fields and API payloads.

| Rule         | Pattern                          | Example                    |
| ------------ | -------------------------------- | -------------------------- |
| Simple field | `snake_case`                     | `user_id`                  |
| Boolean      | `is_{adjective}` or `has_{noun}` | `is_active`, `has_mfa`     |
| Timestamp    | `{action}_at`                    | `created_at`, `expires_at` |
| Foreign key  | `{entity}_id`                    | `user_id`, `session_id`    |
| Enum field   | `{noun}` (value is the enum)     | `status`, `role`           |
| Count        | `{noun}_count`                   | `retry_count`              |

**Conventions**:

- Use `snake_case` consistently in database schemas and API responses
- Avoid abbreviations (`description`, not `desc`)
- Timestamps always end with `_at` and use ISO 8601 format
- Boolean fields always start with `is_` or `has_`
- Foreign keys always end with `_id`

---

## Error Codes

**Pattern**: `lowercase_underscore`, namespaced by domain.

| Rule             | Pattern                      | Example                     |
| ---------------- | ---------------------------- | --------------------------- |
| Domain error     | `{domain}_{error}`           | `auth_invalid_credentials`  |
| Validation error | `validation_{field}_{issue}` | `validation_email_required` |
| System error     | `system_{error}`             | `system_unavailable`        |
| Rate limit       | `rate_limit_{scope}`         | `rate_limit_exceeded`       |

**Conventions**:

- Error codes are stable identifiers -- do not rename them (breaking change)
- Use descriptive names that indicate the problem, not the HTTP status
- Prefix with domain to prevent collisions across services
- Document all error codes in the contract's `error_codes` field

---

## Security Naming

### Environment Variables and Secrets

| Prefix     | Usage                                                   | Example                     |
| ---------- | ------------------------------------------------------- | --------------------------- |
| `SECRET_`  | Values that must never appear in logs or error messages | `SECRET_JWT_SIGNING_KEY`    |
| `PRIVATE_` | Values restricted to specific services/contexts         | `PRIVATE_DB_PASSWORD`       |
| No prefix  | Non-sensitive configuration values                      | `API_BASE_URL`, `LOG_LEVEL` |

**Conventions**:

- `SECRET_` prefix triggers log redaction in structured logging
- `PRIVATE_` prefix triggers access-control checks in configuration systems
- Never store secrets in `.env` files committed to version control
- Use `UPPER_SNAKE_CASE` for all environment variables

### PII Field Markers

| Prefix    | Usage                                                      | Example                    |
| --------- | ---------------------------------------------------------- | -------------------------- |
| `pii_`    | Fields containing personally identifiable information      | `pii_email`, `pii_phone`   |
| No prefix | Fields listed in `pii_fields` array of data model contract | `ip_address`, `user_agent` |

**Conventions**:

- Fields in the data model contract's `pii_fields` array are PII regardless of name prefix
- The `pii_` prefix is an additional marker for fields outside formal contracts
- PII fields trigger data retention, encryption, and access logging requirements
- Use `data_classification` in data model contracts for entity-level classification

---

## Existing Exceptions

Legacy patterns that predate these conventions. These are valid in existing code but should not be used in new code.

| Legacy Pattern               | Convention                | Where Found            | Migration Status              |
| ---------------------------- | ------------------------- | ---------------------- | ----------------------------- |
| `camelCase` API fields       | `snake_case`              | Legacy REST responses  | Migrate on next major version |
| Header-based versioning      | Path-based versioning     | N/A (no current usage) | N/A                           |
| `SCREAMING_CASE` event names | `dot.separated` lowercase | N/A (no current usage) | N/A                           |

When modifying a file that uses a legacy pattern, follow the legacy pattern within that file for consistency. Propose a migration to new conventions as a separate refactoring task.

---

## API Versioning Strategy

**Path-based versioning is the sole versioning strategy.**

```
/api/v1/users     -- version 1
/api/v2/users     -- version 2 (breaking changes from v1)
```

**Rules**:

- Increment the version number only for breaking changes
- Non-breaking additions (new optional fields, new endpoints) do not require a version bump
- Maintain the previous version for a deprecation period before removal
- Document the deprecation timeline in the contract's `context:` field
- A breaking change in a contract requires a new contract version with `-v2` suffix (append-only rule)
