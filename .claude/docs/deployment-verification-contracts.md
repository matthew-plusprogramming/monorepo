# Deployment Verification Contracts

Consumer projects implement their own verification logic behind these contract interfaces. The framework defines the rules and interfaces; projects own the test implementations.

## verify:build Contract

**Purpose**: Exercise the build artifact in a target-approximating context before deployment.

**Interface**:

- **Script name**: `verify:build` (npm script in `package.json`)
- **Invocation**: `npm run verify:build`
- **Exit code semantics**: Exit 0 = PASS, non-zero = FAIL
- **Timeout**: 5 minutes (300 seconds)
- **stdout/stderr**: Captured for audit trail
- **Audit**: The framework logs the actual resolved script command text from `package.json` (not just the npm script name)

**When missing**: Advisory warning emitted (`No verify:build script -- deployment verification skipped`). Execution proceeds without blocking. The stop hook does NOT enforce verify:build -- it is advisory only.

### Example Implementations

```json
// AWS CDK / CDKTF
{
  "scripts": {
    "verify:build": "cdktf synth --output dist && node dist/main.js"
  }
}

// Docker
{
  "scripts": {
    "verify:build": "docker build -t app:test . && docker run --rm app:test node healthcheck.js"
  }
}

// AWS SAM
{
  "scripts": {
    "verify:build": "sam build && sam local invoke --event test-event.json"
  }
}

// Generic Node.js
{
  "scripts": {
    "verify:build": "node -e \"require('./dist/index.js')\""
  }
}
```

## verify:deploy Contract

**Purpose**: Post-deploy smoke test to confirm the deployed service is alive and responding.

**Interface**:

- **Script name**: `verify:deploy` (npm script in `package.json`)
- **Invocation**: `npm run verify:deploy -- <endpoint-url>`
- **First argument**: The deployed endpoint URL
- **Exit code semantics**: Exit 0 = PASS, non-zero = FAIL
- **Timeout**: 30 seconds

**HTTP GET Fallback** (when `verify:deploy` script not declared):

- Method: GET
- Pass status codes: 200, 401, 403 (proves runtime is alive; auth middleware loaded)
- Fail conditions: 5xx, timeout, connection error
- Configuration: no-follow-redirects, skip TLS verification for localhost, standard User-Agent
- Timeout: 30 seconds

**When missing AND no endpoint URL**: Advisory warning emitted. `verify_deploy_passed` remains `false`. Stop hook blocks session completion per the deploy-means-test rule.

### Example Implementations

```json
// Simple curl health check
{
  "scripts": {
    "verify:deploy": "curl -sf \"$1\" --max-time 10"
  }
}

// Custom Node.js health check
{
  "scripts": {
    "verify:deploy": "node scripts/health-check.js"
  }
}

// With retry logic
{
  "scripts": {
    "verify:deploy": "for i in 1 2 3; do curl -sf \"$1\" && exit 0; sleep 5; done; exit 1"
  }
}
```

## Enforcement Rules

| Verification Step        | Enforcement Level | Stop Hook Behavior                                                              |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------- |
| `verify:build`           | Advisory          | Warning if missing or failed; never blocks session completion                   |
| `verify:deploy`          | Coercive          | Blocks session completion when deployment detected without passing verification |
| `deployment.failed=true` | Override          | Clears all verification requirements (no artifact to verify)                    |

## Session State Fields

The deployment state is tracked in `session.json` under the `deployment` object:

| Field                  | Type                   | Default | Description                              |
| ---------------------- | ---------------------- | ------- | ---------------------------------------- |
| `detected`             | boolean                | false   | Whether deployment activity was detected |
| `timestamp`            | string (ISO 8601)      | -       | When deployment was detected             |
| `target`               | string                 | -       | Deployment target identifier             |
| `method`               | enum: pipeline, manual | -       | How deployment was triggered             |
| `verified`             | boolean                | false   | Legacy compat field                      |
| `verify_build_passed`  | boolean                | false   | Whether verify:build passed              |
| `verify_deploy_passed` | boolean                | false   | Whether post-deploy smoke test passed    |
| `failed`               | boolean                | false   | Whether deployment itself failed         |

## CLI Commands

```bash
# Record deployment
node .claude/scripts/session-checkpoint.mjs record-deployment --target <target> --method pipeline

# Record manual deployment
node .claude/scripts/session-checkpoint.mjs record-deployment --target <target> --manual

# Record deployment failure (clears verification requirement)
node .claude/scripts/session-checkpoint.mjs record-deployment-failure
```

## Authoring a Deployment Manifest (REQ-013)

Deployment manifests enable method-coverage smoke testing (POST/PUT/PATCH probes beyond GET-only fallback).

**Location**: `.claude/deployment-manifests/<service>.json`

**Schema version**: `"1.0"` (exact literal, validated by Zod `z.literal("1.0")`)

### Minimal Example (GET-only service)

```json
{
  "schema_version": "1.0",
  "service": "my-api",
  "base_url": "https://api.example.com",
  "routes": [{ "method": "GET", "path": "/health" }]
}
```

### Multi-Route Example

```json
{
  "schema_version": "1.0",
  "service": "life-api",
  "base_url": "https://api.life.example.com",
  "routes": [
    { "method": "GET", "path": "/health" },
    {
      "method": "POST",
      "path": "/api/items",
      "body_skeleton": { "name": "smoke-test-invalid" }
    },
    {
      "method": "PUT",
      "path": "/api/items/0",
      "body_skeleton": { "name": "updated" },
      "timeout_ms": 3000
    },
    { "method": "DELETE", "path": "/api/items/0" }
  ],
  "deployment_env_allowlist": ["AWS_REGION", "DB_HOST", "NODE_ENV"]
}
```

### Route Fields

| Field             | Type             | Required | Default                          | Description                     |
| ----------------- | ---------------- | -------- | -------------------------------- | ------------------------------- |
| `method`          | enum             | Yes      | -                                | GET, POST, PUT, DELETE, PATCH   |
| `path`            | string           | Yes      | -                                | URL path (joined with base_url) |
| `expected_status` | number[]         | No       | Method-default (see below)       | HTTP statuses counted as PASS   |
| `body_skeleton`   | object           | No       | `{}` for POST/PUT/PATCH          | Request body for write probes   |
| `timeout_ms`      | number           | No       | 5000                             | Per-probe timeout (ms)          |
| `headers`         | Record\<string\> | No       | Content-Type auto-added for body | Additional request headers      |

### Method-Default Expected Status Allowlists

| Method | Default Pass Codes           | Rationale                        |
| ------ | ---------------------------- | -------------------------------- |
| GET    | 200, 401, 403                | Standard health + auth checks    |
| POST   | 200, 201, 400, 401, 403, 422 | 4xx proves endpoint is reachable |
| PUT    | 200, 201, 400, 401, 403, 422 | 4xx proves endpoint is reachable |
| DELETE | 200, 204, 401, 403, 404      | 404 acceptable (resource absent) |
| PATCH  | 200, 204, 400, 401, 403, 422 | 4xx proves endpoint is reachable |

**Why 4xx counts as PASS**: The method-coverage smoke test is a _liveness_ check, not a _correctness_ check. A 400/422 response proves the endpoint is reachable, the server is running, and request parsing works. Body schema failures are not liveness failures. Recommended: use `body_skeleton` values that trigger 4xx intentionally.

### Side Effects Warning

POST/PUT/PATCH probes with `body_skeleton` send **real requests** against live endpoints. Non-idempotent endpoints will create real records. Mitigations:

1. Use `body_skeleton` values that trigger validation failure (4xx)
2. Point manifests at staging environments for smoke tests
3. Accept the side-effect cost and rely on data hygiene

## Post-Intervention Env State Reconciliation (REQ-014)

When a deployment fails and an operator clears `deployment.failed`, the framework compares the current environment state against the captured state at deploy time.

### Env Hash Capture

At `record-deployment` time (with `--service <name>`), if the manifest declares `deployment_env_allowlist`, the SHA-256 hash of the canonical env-var map is stored as `deployment.expected_env_hash` in session.json.

### Clearing a Failed Deployment

```bash
# If env hash matches (no divergence):
node .claude/scripts/session-checkpoint.mjs record-deployment-clear-failure --service <name>

# If env hash diverges (requires signed intervention):
# 1. Author intervention record (see template below)
# 2. Commit with signature: git commit -S -m "intervention: <details>"
# 3. Clear with signed record:
node .claude/scripts/session-checkpoint.mjs record-deployment-clear-failure \
  --service <name> --signed-record <path-to-record>
```

### Signed Intervention Ceremony

When the env hash diverges, the operator must commit a signed record acknowledging the divergence:

1. Fill in `.claude/templates/deployment-intervention-record.template.md`
2. Required commit message fields: service, intervention_timestamp, pre/post hashes, divergence_kind, maintainer_rationale (>= 50 chars)
3. Commit with `git commit -S` (maintainer-signed)
4. The commit must touch `.claude/audit/deployment-interventions.log`
5. Signer identity must match CODEOWNERS

### Verifying the Audit Chain

```bash
node .claude/scripts/verify-deployment-audit-chain.mjs
# Exit 0: chain valid
# Exit 1: chain broken at index N
# Exit 2: log file missing
```

## Session State Fields

| Field                  | Type                   | Default | Description                              |
| ---------------------- | ---------------------- | ------- | ---------------------------------------- |
| `detected`             | boolean                | false   | Whether deployment activity was detected |
| `timestamp`            | string (ISO 8601)      | -       | When deployment was detected             |
| `target`               | string                 | -       | Deployment target identifier             |
| `method`               | enum: pipeline, manual | -       | How deployment was triggered             |
| `verified`             | boolean                | false   | Legacy compat field                      |
| `verify_build_passed`  | boolean                | false   | Whether verify:build passed              |
| `verify_deploy_passed` | boolean                | false   | Whether post-deploy smoke test passed    |
| `failed`               | boolean                | false   | Whether deployment itself failed         |
| `expected_env_hash`    | string \| null         | null    | SHA-256 of env-var map at deploy time    |

## CLI Commands

```bash
# Record deployment
node .claude/scripts/session-checkpoint.mjs record-deployment --target <target> --method pipeline

# Record deployment with env hash capture
node .claude/scripts/session-checkpoint.mjs record-deployment --target <target> --method pipeline --service <name>

# Record manual deployment
node .claude/scripts/session-checkpoint.mjs record-deployment --target <target> --manual

# Record deployment failure (clears verification requirement)
node .claude/scripts/session-checkpoint.mjs record-deployment-failure

# Clear deployment failure (with env reconciliation)
node .claude/scripts/session-checkpoint.mjs record-deployment-clear-failure --service <name>
```

## Cross-Reference

- **Spec**: `.claude/specs/groups/sg-deployment-verification-gaps/spec.md`
- **Requirements**: `.claude/specs/groups/sg-deployment-verification-gaps/requirements.md`
- **Schema**: `.claude/specs/schema/session.schema.json` (deployment object)
- **Stop Hook**: `.claude/scripts/workflow-stop-enforcement.mjs` (Step 7.8)
- **Verification Runners**: `.claude/scripts/lib/deployment-verify.mjs`
- **Manifest Schema**: `.claude/scripts/lib/deployment-manifest-schema.mjs`
- **Audit Log**: `.claude/audit/deployment-interventions.log`
- **Chain Verifier**: `.claude/scripts/verify-deployment-audit-chain.mjs`
