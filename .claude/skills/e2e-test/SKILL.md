---
name: e2e-test
description: Generate end-to-end tests from spec contracts. Produces Playwright browser tests for frontend and HTTP API tests for backend. Black-box only -- never reads implementation source code. Runs in parallel with implementer and test-writer.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: true
---

# E2E Test Skill

## Purpose

Generate end-to-end tests that exercise the real deployed system through its external surfaces. Tests are derived from spec contracts only -- never from implementation code.

**Key Input**: Spec group with cross-boundary contracts at `.claude/specs/groups/<spec-group-id>/`

## Usage

```
/e2e-test <spec-group-id>                    # Generate E2E tests for all cross-boundary ACs
/e2e-test <spec-group-id> --skip-execution   # Generate tests but skip execution
```

## Prerequisites

Before using this skill, verify:

1. **Spec group exists** at `.claude/specs/groups/<spec-group-id>/`
2. **Spec has cross-boundary contracts** (HTTP, SSE, WebSocket, database, external service boundaries)
3. **Contract templates available** at `.claude/contracts/templates/` (REST API, event, data model, behavioral)
4. **`tests/e2e/` directory exists** (created by Task 3b or present in project)

If the spec has only internal contracts (module-to-module within same process), report E2E gate as **N/A** and exit.

## 3-Way Parallel Dispatch

This skill runs as part of a 3-way parallel dispatch when a spec has cross-boundary contracts:

```
Spec Approved + Challenges Pass
        |
   [Has cross-boundary contracts?]
        |                    |
       YES                  NO
        |                    |
  3-way parallel      2-way parallel
  - implementer       - implementer
  - test-writer       - test-writer
  - e2e-test-writer
```

The e2e-test-writer has no ordering dependency on the implementer or test-writer. All three agents work from the spec only.

## Independent Verification (Practice 2.4)

The e2e-test-writer **must not see the implementation**. It receives only:

- `spec_group_id` -- identifies the spec group
- `acceptance_criteria` -- cross-boundary ACs from the spec
- `contract_definitions` -- contract blocks from the spec

It never receives implementation file paths, source code, or internal module structure. This is enforced technically by the PreToolUse black-box enforcement hook.

## Test Generation Workflow

### Step 1: Load Spec and Contracts

```bash
# Load spec
cat .claude/specs/groups/<spec-group-id>/spec.md

# Load requirements
cat .claude/specs/groups/<spec-group-id>/requirements.md

# Load contract templates
ls .claude/contracts/templates/
```

Extract:

- Cross-boundary acceptance criteria
- Inline contract blocks (yaml:contract sections)
- Contract template references

### Step 2: Validate Contracts

For each contract referenced by the spec:

1. Verify the contract template exists at `.claude/contracts/templates/`
2. Verify the contract is parseable (valid YAML)
3. If any contract is missing or unparseable: **report blocker** with specific path and error, do NOT generate partial tests

### Step 3: Generate Test Plan

Use the template at `.claude/templates/e2e-test-plan.template.md` to map contracts to test cases:

| Contract Type | Test Type    | Tool                |
| ------------- | ------------ | ------------------- |
| REST API      | HTTP test    | fetch / supertest   |
| Event (SSE)   | HTTP test    | fetch + EventSource |
| Frontend UI   | Browser test | Playwright          |
| Behavioral    | Depends      | Playwright or HTTP  |

For each cross-boundary AC, determine:

- Test type (Playwright vs HTTP)
- Test assertions (external inputs/outputs only)
- Setup requirements (authentication, seed data)
- Teardown requirements (cleanup with verification)
- Expected outcomes

### Step 4: Generate Tests

Write test files to `tests/e2e/<spec-group-id>/`:

**Frontend tests (Playwright)**:

```typescript
import { test, expect } from '@playwright/test';

test.describe('<spec-group-id> - <AC-ID>', () => {
  const RUN_ID = `e2e-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  test.beforeEach(async ({ page }) => {
    // Setup: dedicated test credentials, run-ID-prefixed data
  });

  test.afterEach(async ({ page }) => {
    // Teardown: cleanup with mandatory verification
  });

  test('<AC description>', async ({ page }) => {
    // Arrange - setup via external surfaces only
    // Act - interact through UI
    // Assert - verify visible outcomes only
  });
});
```

**Backend tests (HTTP)**:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('<spec-group-id> - <AC-ID>', () => {
  const RUN_ID = `e2e-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';

  beforeEach(async () => {
    // Setup: dedicated test credentials, seed data with run-ID prefix
  });

  afterEach(async () => {
    // Teardown: cleanup with mandatory verification
    // Verify cleanup: GET resource returns 404
  });

  it('<AC description>', async () => {
    // Arrange
    // Act - HTTP request to real server
    // Assert - verify response shape matches contract
  });
});
```

### Step 5: Health Check

Before executing tests, validate server availability:

```typescript
const HEALTH_CHECK_TIMEOUT_MS = 30000;
const HEALTH_CHECK_MAX_RETRIES = 3;

async function healthCheck(baseUrl: string): Promise<boolean> {
  for (let attempt = 1; attempt <= HEALTH_CHECK_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        HEALTH_CHECK_TIMEOUT_MS,
      );
      const response = await fetch(`${baseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) return true;
    } catch {
      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return false;
}
```

- **Server available**: Execute tests, report results
- **Server unavailable**: Report clear error message (not silent hang), tests are still generated and can be run later

### Step 6: Execute Tests (If Server Available)

```bash
# Run Playwright tests
npx playwright test tests/e2e/<spec-group-id>/

# Run API tests
npx vitest run tests/e2e/<spec-group-id>/
```

### Step 7: Report Results

Return to orchestrator using the output contract:

```markdown
status: success | partial | failed
summary: |
Generated N E2E tests for spec-group-id covering M cross-boundary ACs.
Frontend tests: X (Playwright). Backend tests: Y (HTTP).
Server health check: available/unavailable.
Test execution: N passing, M failing (or "skipped - server unavailable").
e2e_test_files_created:

- tests/e2e/<spec-group-id>/frontend.test.ts
- tests/e2e/<spec-group-id>/api.test.ts
  blockers: []
```

## Test Quality Requirements

### Determinism

Tests must be deterministic given consistent server state. Flaky tests are treated as bugs requiring investigation and fix.

### Isolation

Each test sets up its own preconditions and cleans up after itself. No test-to-test ordering dependency. Tests must pass with randomized execution order.

### Execution Time

E2E test suite execution per spec should complete within 5 minutes.

## Test Data Hygiene

### Dedicated Test Credentials

E2E tests use separate credentials from dev environment. Never share credentials with development.

### Namespace Isolation

All test data is prefixed with a unique run ID: `e2e-run-<uuid>-<entity>`. This prevents collision during concurrent test runs.

### Mandatory Cleanup Verification

After teardown, verify that cleanup actually succeeded:

```typescript
// After deleting a test resource
const verifyResponse = await fetch(
  `${BASE_URL}/api/resource/${testResourceId}`,
);
expect(verifyResponse.status).toBe(404); // Verify deletion succeeded
```

## URL Allowlisting

E2E tests may only target:

- `localhost` (any port)
- Known preview domains (configured per project)

Arbitrary external URLs are prohibited to prevent data leakage.

## Black-Box Guarantee

All assertions measure external inputs and outputs only:

- HTTP response status codes and bodies
- UI element visibility and text content
- Browser console output
- Network request/response shapes

Never assert on:

- Internal state
- Implementation source code
- Private APIs
- Database contents directly (use API endpoints)

## Conflict Resolution Protocol

### Contract-Authoritative Resolution

Contracts are the single source of truth for E2E test correctness:

1. **E2E test fails, implementation matches contracts**: Implementation is correct. Investigate E2E test logic for bugs.
2. **Implementation deviates from contracts**: Implementation has a bug, regardless of E2E test results.
3. **Spec amendment changes contracts**: Regenerate E2E tests from amended contracts before re-validation.

### Contradictory E2E vs Unit Test Results

When E2E and unit tests produce contradictory results for the same AC:

- Surface both results to the implementer
- Flag the discrepancy explicitly
- Do NOT silently prefer either result
- The implementer investigates using logs, observability, and contract definitions

### Spec Defect Escalation

When an E2E test failure reveals a spec defect (not an implementation defect):

- Escalate the finding to the human
- A spec amendment may be needed before implementation fix
- Do not attempt to resolve spec-level issues independently

## Missing Contract Template Handling

When a contract template referenced by a spec is missing or unparseable:

1. Report a **blocker** with the specific template path and parse error
2. Do NOT generate partial tests
3. Provide actionable diagnostics so the root cause can be fixed before retry

## Error Handling

### Server Unavailable

```markdown
status: partial
summary: |
Generated N E2E tests but server health check failed after 3 retries.
Tests written to tests/e2e/<spec-group-id>/ and can be executed when server is available.
blockers:

- Server unavailable at <base-url> after 3 retries (30s timeout each)
```

### Missing Contracts

```markdown
status: failed
summary: |
Cannot generate E2E tests. Contract template missing or unparseable.
blockers:

- Missing contract template: .claude/contracts/templates/<template-name>.template.yaml
- Parse error: <specific error message>
```

## Integration with Other Skills

This skill integrates with the convergence pipeline:

- **Unifier Step 9**: Validates E2E test coverage for cross-boundary ACs
- **Completion Verifier Gate 5**: Verifies E2E tests exist and pass (all-or-nothing)
- Both gates report N/A for specs without cross-boundary contracts
