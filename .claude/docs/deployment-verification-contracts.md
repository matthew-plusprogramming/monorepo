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

## Cross-Reference

- **Spec**: `.claude/specs/groups/sg-deployment-verification-gaps/spec.md`
- **Requirements**: `.claude/specs/groups/sg-deployment-verification-gaps/requirements.md`
- **Schema**: `.claude/specs/schema/session.schema.json` (deployment object)
- **Stop Hook**: `.claude/scripts/workflow-stop-enforcement.mjs` (Step 7.8)
- **Verification Runners**: `.claude/scripts/lib/deployment-verify.mjs`
