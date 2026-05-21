---
_source_modules: []
---

# Interface-Investigator Category Patterns

Canonical grep-pattern gallery, example findings, and report templates for the 8 cross-spec / intra-spec investigation categories used by `.claude/agents/interface-investigator.md`. Relocated from the agent file to reduce per-dispatch token weight. The agent references this doc on demand when a specific category path requires detailed patterns.

## Applicability

Categories 1-6 are primarily cross-spec and cross-workstream checks. Category 7 (Intra-Spec Wire Format & Contract Consistency) and Category 8 (Contract Completeness) apply even when investigating a single spec group. Always run Categories 7-8 regardless of scope.

## Categories

### 1. Environment Variable Consistency

Different specs may reference the same concept with different names:

- `GIT_SSH_KEY_PATH` vs `GIT_SSH_KEY_BASE64` vs `GIT_SSH_KEY`
- `CONTAINER_IMAGE` + `CONTAINER_IMAGE_TAG` vs combined `CONTAINER_IMAGE`
- Missing variables in templates (e.g., `HMAC_SECRET` in one but not another)

**How to investigate**:

```bash
# Find all env var references across specs
grep -rh "^[A-Z][A-Z0-9_]*=" .claude/specs/ | sort | uniq
grep -rh "\$\{[A-Z][A-Z0-9_]*\}" .claude/specs/ | sort | uniq
grep -rh "process\.env\.[A-Z]" .claude/specs/ | sort | uniq

# Find env template files
find .claude/specs -name "*.env*" -o -name "*environment*"
```

### 2. API Endpoint Consistency

Different specs may assume different API patterns:

- Hardcoded URLs vs discovery patterns
- Different path conventions (`/api/auth/logout` vs `/auth/logout`)
- Different HTTP methods for same operation

**How to investigate**:

```bash
# Find API references
grep -rh "POST\|GET\|PUT\|DELETE\|PATCH" .claude/specs/ --include="*.md"
grep -rh "/api/" .claude/specs/ --include="*.md"
grep -rh "endpoint" .claude/specs/ --include="*.md"
```

### 3. Data Shape Consistency

Different specs may define the same data structure differently:

- Field naming (`userId` vs `user_id` vs `UserID`)
- Required vs optional fields
- Type differences (string vs enum)

**How to investigate**:

```bash
# Find data model definitions
grep -rh -A 10 "## Data Model\|## Interface\|## Schema" .claude/specs/
```

### 4. Deployment Assumption Consistency

Different specs may assume different deployment approaches:

- CDK vs Terraform vs CloudFormation
- Lambda vs ECS vs EC2
- SSM vs Secrets Manager vs .env files

**How to investigate**:

```bash
# Find deployment references
grep -rh "CDK\|Terraform\|CloudFormation\|Lambda\|ECS\|SSM\|Secrets Manager" .claude/specs/
```

### 5. Cross-Spec Dependencies

Specs that depend on each other may have mismatched assumptions:

- Spec A assumes Spec B provides endpoint X, but Spec B doesn't define it
- Circular dependencies
- Version mismatches

**How to investigate**:

```bash
# Find dependency declarations
grep -rh "depends\|requires\|assumes\|prerequisite" .claude/specs/ --include="*.md"
```

### 6. Cross-Workstream Naming Consistency

When investigating multi-workstream specs, check for naming convention consistency:

**Environment Variable Prefixes**:

```bash
# Extract all env var references and check prefix consistency
grep -rh "[A-Z][A-Z0-9_]*=" .claude/specs/groups/<spec-group-id>/ | cut -d= -f1 | sort | uniq
# Check: Do all workstreams use the same prefix convention? (e.g., APP_, NEXT_, VITE_)
```

**API Field Casing**:

```bash
# Check for mixed casing in API contracts
grep -rh '"[a-z][a-zA-Z]*":' .claude/specs/ --include="*.md"  # camelCase
grep -rh '"[a-z][a-z_]*":' .claude/specs/ --include="*.md"    # snake_case
# Report if both conventions found across workstreams
```

**Constant Naming Patterns**:

```bash
# Check for consistent constant naming
grep -rh "const [A-Z_]" .claude/specs/ --include="*.md"
# Verify: UPPER_SNAKE_CASE for constants across all workstreams
```

**Report Format**:

```markdown
## Naming Consistency: PASS | ISSUES FOUND

| Convention             | Workstreams Using | Conflicts            |
| ---------------------- | ----------------- | -------------------- |
| Env var prefix: APP\_  | ws-1, ws-2        | ws-3 uses NEXT\_     |
| API fields: camelCase  | ws-1              | ws-2 uses snake_case |
| Constants: UPPER_SNAKE | all               | none                 |

### Naming Decisions Required

| ID      | Convention | Options                 | Recommendation               | Affected |
| ------- | ---------- | ----------------------- | ---------------------------- | -------- |
| NAM-001 | API casing | camelCase vs snake_case | camelCase (matches existing) | ws-2     |
```

### 7. Intra-Spec Wire Format & Contract Consistency

Categories 1-6 check across specs and workstreams. This category checks **within** a single spec group — specifically when the same spec group contains both a producer (e.g., SSE service) and a consumer (e.g., test code or client code). These mismatches are invisible to cross-spec investigation because both sides live in the same workstream.

**This category should be checked EVEN for single-spec-group investigations**, not just cross-workstream. It is the one category that applies when there is only one spec group in scope.

**What to check**:

- **SSE/WebSocket event type naming**: Does the emitter add prefixes (e.g., `sdlc:`) that the consumer doesn't expect? Compare `broadcastSdlcEvent` event names with consumer `EventSource` type checks.
- **Payload nesting depth**: Does the producer wrap fields in a `payload` object that the consumer reads at the top level? Compare emitted shapes with consumed field access paths.
- **Cookie/header encoding**: Does one side URL-encode values that the other reads raw? Compare `res.cookie()` output with `request.headers.cookie` parsing.
- **Schema fixture alignment**: Do test fixtures match the runtime Zod/joi validation schemas? Compare test payloads field-by-field against validator schemas.
- **Middleware bypass gaps**: Does a handler read data differently when accessed through middleware vs. directly? Compare `req.cookies` (parsed by cookie-parser) vs. `request.headers.cookie` (raw).

**Grep patterns for detection**:

```bash
# SSE event type prefixing
grep -rn "event:.*sdlc:" --include="*.ts" # producer prefixes
grep -rn "event\.type\s*===\|\.type\s*===\|findSseEvent" --include="*.ts" # consumer checks

# Payload nesting
grep -rn "payload:" --include="*.ts" # where payload wrapping happens
grep -rn "data\.\w\+\s*??" --include="*.ts" # where flat field access happens

# Cookie encoding
grep -rn "res\.cookie\|setCookie\|Set-Cookie" --include="*.ts" # cookie setters
grep -rn "request\.headers\.cookie\|parseCookies" --include="*.ts" # raw cookie readers

# Schema vs fixture
grep -rn "z\.object\|z\.string\|Schema\s*=" --include="*.ts" # Zod schemas
grep -rn "body:\s*{\\|payload:\s*{" tests/ --include="*.ts" # test fixtures
```

**Severity**: Typically **HIGH** (causes silent 401s, empty matches, timeouts — hard to debug because each side looks correct in isolation).

**Example inconsistency (real-world)**:

```markdown
ISSUE: SSE event type prefix mismatch (HIGH)
Producer: sse.service.ts:broadcastSdlcEvent() sends event: `sdlc:${event.type}`
Consumer: smoke-test.ts:findSseEvent() checks event.type === 'team-status-changed'
Impact: Consumer never matches events, test times out silently
Decision: DEC-XXX — Normalize event types at consumer or remove prefix at producer
```

### 8. Contract Completeness (Semantic Validation)

Categories 1-7 check structural and wire-level consistency. This category checks **semantic completeness** of contract definitions within specs -- content quality issues that structural validation (contract-validate.mjs) cannot catch.

**This category should be checked for ALL investigations** (single-spec and cross-workstream). It applies whenever specs contain `## Interfaces & Contracts` sections with `yaml:contract` blocks.

**Note**: Structural completeness (required fields present, YAML parseable) is handled by explicit `contract-validate.mjs` checkpoint runs. This category focuses on semantic quality that requires cross-reference checking.

**What to check**:

- **Field value consistency across specs**: Do multiple specs referencing the same endpoint/event/entity use consistent field values? (e.g., one spec says `auth_method: bearer-token`, another says `auth_method: none` for the same endpoint)
- **No placeholder content**: Contract fields must not contain placeholder text like "TODO", "TBD", "FIXME", or template angle-bracket markers like `<endpoint path>`
- **Contract references resolve**: If a contract references another contract, template, or path, verify the reference target exists
- **Naming conventions followed**: Verify contract field values follow the patterns in `.claude/contracts/naming-conventions.md`:
  - REST API paths use kebab-case with path-based versioning (`/api/v{n}/...`)
  - Event names use dot-separated lowercase (`resource.action`)
  - Data model fields use snake_case
  - Error codes use lowercase_underscore
- **Security field coherence**: Do security field values make sense together? (e.g., `auth_method: none` with `auth_scope: admin` is contradictory)
- **Boundary visibility alignment**: If a contract is marked `boundary_visibility: internal`, verify it is not exposed to external consumers in another spec

**Grep patterns for detection**:

```bash
# Find all yaml:contract blocks in specs
grep -rn "yaml:contract" .claude/specs/ --include="*.md"

# Find placeholder content in contract sections
grep -rn "TODO\|TBD\|FIXME\|<.*>" .claude/specs/ --include="*.md" | grep -i "contract\|interface"

# Find naming convention violations
grep -rn "path:.*[A-Z]" .claude/specs/ --include="*.md"  # Uppercase in paths
grep -rn "event_name:.*[A-Z]" .claude/specs/ --include="*.md"  # Uppercase in events

# Find duplicate endpoint definitions across specs
grep -rn "^path:" .claude/specs/ --include="*.md" | sort -t: -k3 | uniq -d -f2
```

**Severity**: Typically **MEDIUM** for naming violations, **HIGH** for cross-spec value inconsistencies and unresolved placeholders.

**Example inconsistency**:

```markdown
ISSUE: Cross-spec auth_method mismatch (HIGH)
Spec A (.claude/specs/groups/sg-auth/spec.md:42): auth_method: bearer-token for POST /api/v1/users
Spec B (.claude/specs/groups/sg-admin/spec.md:87): auth_method: none for POST /api/v1/users
Impact: Implementers will produce conflicting auth middleware; one will break at integration
Decision: DEC-XXX -- Resolve canonical auth method for /api/v1/users
```

**Report Format**:

```markdown
## Contract Completeness: PASS | ISSUES FOUND

| Check                  | Result    | Details                |
| ---------------------- | --------- | ---------------------- |
| Placeholder content    | PASS/FAIL | N found in M specs     |
| Cross-spec consistency | PASS/FAIL | N conflicts found      |
| Naming conventions     | PASS/FAIL | N violations found     |
| Reference resolution   | PASS/FAIL | N broken references    |
| Security coherence     | PASS/FAIL | N contradictions found |
```
