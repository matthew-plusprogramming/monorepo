---
name: manual-test
description: Bounded exploratory end-to-end verification — 5 happy paths + 3 failure injections + 2 adjacent surfaces, then stop. Runs after /docs as the final pipeline step. Advisory by default; mandatory for runtime-validation-required specs. Findings are logged to session.subagent_tasks, surfaced in a narrative report, and recorded as structured result data when runtime validation is required.
user-invocable: true
allowed-tools: Read, Grep, Bash, Write, mcp__playwright-mcp__*
---

# Manual Test Skill

## Required Context

Before beginning work, read these files for project-specific guidelines:

- `.claude/memory-bank/testing.guidelines.md`
- `.claude/memory-bank/best-practices/logging.md`

## Purpose

Execute **bounded exploratory end-to-end verification** against the running application for a completed spec group. Capture narrative evidence. Surface findings the generated E2E suite could not encode.

This skill is NOT a replacement for `/e2e-test`. That skill generates contract-driven tests from spec interfaces. This skill explores _beyond_ those tests: judgment-dependent failure modes and adjacent regressions.

For specs whose frontmatter declares `runtime_validation_required: true`, this skill is a Stop-hook gate. The main agent must record a passing structured result through `session-checkpoint.mjs` before terminal completion.

## When to Use

Dispatched as the **final step after `/docs`** in spec-based workflows (oneoff-spec and orchestrator). Both `/docs/SKILL.md` § "After docs" and `/route/SKILL.md` workflow-integration rows list `/manual-test` after `/docs` and before commit.

**Default invocation**: Advisory. Findings are logged in `session.subagent_tasks.completed_this_session[]` and surfaced to the user.

**Runtime-validation invocation**: Mandatory when any `spec.md` or `atomic/*.md` frontmatter in the active spec group declares:

```yaml
runtime_validation_required: true
runtime_validation_surface: plugin | mcp | connector | browser-extension | dynamic-tool-body | plugin-loader | other
runtime_validation_rationale: 'Why static/generated gates are insufficient.'
```

For these specs, the Stop hook requires a `manual-tester` dispatch record plus a structured result with `result: "pass"` and an existing evidence report under `.claude/specs/groups/<sg-id>/evidence/`.

**Required system prerequisites** (one-time per environment):

```bash
# Playwright MCP needs browser binaries
npx playwright install chromium
```

**`.mcp.json`** at project root declares the MCP servers. If `.mcp.json` is absent or the MCP servers are not installed, the agent reports gracefully. For runtime-validation-required specs, that is a structured `blocked` result and it blocks completion unless an explicit `runtime_manual_test` override is recorded with a rationale.

## Bounded Scope

Ten scenarios total:

- **5 happy paths**: Central user journeys from the spec's core flows / acceptance criteria. Not every AC — the 5 that represent most of the feature's value.
- **3 failure injections**: Production-realistic failure modes. Network drop, upstream 500, auth expiry, rate limit, stale cache, race between concurrent users.
- **2 adjacent surfaces**: Behavior near but not in the spec — shared component, sibling endpoint, overlapping error path, neighbor page importing the same module.

If the change is too small to sustain 5 happy paths, reduce proportionally and document the reduction in the Scope section of the report.

Stop after the selected scenario set. If another branch looks worth exploring, record it in Residual Risks instead of expanding scope mid-run.

## Process

### Step 1: Load Spec Group

```bash
cat .claude/specs/groups/<spec-group-id>/spec.md
cat .claude/specs/groups/<spec-group-id>/manifest.json
ls .claude/specs/groups/<spec-group-id>/atomic/ 2>/dev/null || true
```

Read acceptance criteria, core flows, and the implementation evidence table. Identify the feature's risk surface.

### Step 2: Identify 10 Scenarios

Write scenario IDs and one-line descriptions in advance:

```
happy-1   User logs in, navigates to dashboard, clicks primary CTA.
happy-2   User completes end-to-end checkout.
happy-3   User sees empty-state when no records exist.
happy-4   User switches between two main tabs.
happy-5   User persists a change across reload.

failure-1 Upstream API returns 500; user sees retry UI.
failure-2 Auth token expires mid-session; user redirects to login.
failure-3 Network drops during submit; user sees inline error.

adjacent-1 Neighbor page that imports the same error-toast component.
adjacent-2 Sibling endpoint GET /<resource>/:id-neighbor returns 200 and correct shape.
```

Pin the list before execution. Do not add scenarios mid-run.

### Step 3: Configure Tools

**Playwright MCP** (primary): user flows, navigation, form fill, screenshot.

**Bash**: CLI probes — `curl`, `jq`, `dig`, log tailing, database clients.

**Read + Grep**: inspect log files the running app produces.

**Write**: evidence artifacts only, scoped to `.claude/specs/groups/<sg-id>/evidence/`.

### Step 4: Create Evidence Directory

```bash
mkdir -p .claude/specs/groups/<sg-id>/evidence/
```

### Step 5: Execute Scenarios with Playwright MCP

For each happy path:

1. Navigate via Playwright MCP.
2. Execute the flow: clicks, form fills, state transitions.
3. Take screenshot at key decision points (before interaction, after interaction).
4. Write screenshot to `evidence/happy-<N>-<ISO-timestamp>.png`.

For each failure injection:

1. Set up the failure mode (intercept fetch, mock network, set expired token, etc.).
2. Exercise the flow.
3. Capture the user-visible failure response.
4. Capture the server-side log/probe output.

For adjacent surfaces:

1. Navigate / probe the adjacent surface.
2. Verify the change didn't regress it.
3. Capture evidence.

**One execution per scenario.** Failure is the finding; don't retry.

### Step 6: Inspect Logs with Bash + Read + Grep

For each failure injection, verify what the system actually logged:

```bash
# Find error signatures in app logs
grep -i "error\|warn" /path/to/app.log | tail -20

# Or structured logs
grep '"level":"error"' /path/to/app.log | jq -r '.message' | tail -10

# Check upstream probe correlation
curl -s -o /tmp/probe.json -w "%{http_code} %{time_total}s\n" http://localhost:3000/api/health
```

Evidence: log excerpts, probe output, timing data. Write excerpts to `evidence/<scenario-id>-log.txt`.

### Step 7: Capture Evidence

Each scenario produces at least one evidence artifact. Suggested naming:

```
.claude/specs/groups/<sg-id>/evidence/
├── happy-1-<ISO-timestamp>.png
├── happy-2-<ISO-timestamp>.png
├── ...
├── failure-1-<ISO-timestamp>.png
├── failure-1-log.txt
├── failure-2-<ISO-timestamp>.png
├── ...
├── adjacent-1-<ISO-timestamp>.png
├── adjacent-2-probe.json
└── report.md
```

**Redaction**: If a screenshot captures secrets (tokens, user emails, session IDs), crop or redact before writing. Prefer not capturing secrets-bearing pages in the first place.

### Step 8: Write Report

Format:

```markdown
# Manual Test Report — <spec-group-id>

**Date**: <ISO timestamp>
**Environment**: <localhost|staging>
**Tooling**: Playwright MCP + Bash probes

## Scope

- 5 happy paths: [list them]
- 3 failure injections: [list them]
- 2 adjacent surfaces: [list them]
- Reductions from standard bounded set: [if any, with rationale]

## Evidence

- `evidence/happy-1-<ts>.png` — [description]
- `evidence/happy-2-<ts>.png` — [description]
- ...

## Findings

- happy-1: PASS. Observed dashboard renders in 1.2s; CTA triggers expected modal.
- happy-2: PASS. Checkout completes end-to-end; confirmation email logged.
- failure-1: PASS. Retry UI appears; clicking retry issues new request (confirmed via Chrome DevTools network panel).
- failure-2: FAIL. Token expiry does not redirect; user sees 401 error toast but remains on protected page.
- adjacent-1: PASS. Neighbor page toast renders correctly; no regression.
- ...

## Residual Risks

- Did not exercise the batch-upload happy path; spec's AC covers single-upload only.
- failure-2 FAIL may indicate a broader session-handling bug not confined to this spec. Recommend investigation before merge.
- Did not probe the WebSocket reconnection path; out of bounded scope.
```

Write the report to `.claude/specs/groups/<sg-id>/evidence/report.md`.

### Step 9: Record Structured Result And Update Manifest Decision Log

After writing `.claude/specs/groups/<sg-id>/evidence/report.md`, record the structured result through the trusted writer:

```bash
node .claude/scripts/session-checkpoint.mjs record-manual-test-result <sg-id> \
  --result <pass|fail|blocked|infra_blocked> \
  --scenario-count <N> \
  --pass-count <N> \
  --fail-count <N> \
  --evidence-path .claude/specs/groups/<sg-id>/evidence/report.md \
  --top-residual-risk "<one-line risk>" \
  [--evidence <json>] \           # REQUIRED when --result is infra_blocked
  [--dispatch-id <id>]            # REQUIRED when --result is infra_blocked
```

For `--result infra_blocked` invocations, both `--evidence <json>` (the structured `InfraBlockedEvidence` payload — see § INFRA_BLOCKED Workflow below) and `--dispatch-id <id>` (the manual-tester dispatch id) are REQUIRED. The validator rejects the invocation if either is missing, and additionally rejects the invocation when the top-level `--dispatch-id` value disagrees with `evidence.dispatch_id` (a structured "dispatch_id mismatch" error naming both values is emitted to stderr and `session.active_work.manual_test_result` is NOT mutated).

For `--result pass | fail | blocked`, `--evidence` and `--dispatch-id` are OPTIONAL (preserves backward compatibility with the prior three-value contract).

This writes `session.active_work.manual_test_result` and appends the manifest `decision_log` audit entry.

**Do NOT** set any `convergence.manual_tests_passed` flag. Enforcement uses `session.active_work.manual_test_result` only for runtime-validation-required specs. The convergence flag exists for historical / schema-migration reasons; it is not auto-updated by this skill.

### Step 10: Report to Main Agent

Return a structured summary:

```
status: [success|partial|failed]
scenarios: 10/10 executed
outcome: [X pass, Y fail]
evidence: .claude/specs/groups/<sg-id>/evidence/
top_residual_risk: [one-line]
```

Main agent presents findings to user. User decides merge vs re-invoke `/implement`.

## INFRA_BLOCKED Workflow

The `manual-tester` agent emits `result: "infra_blocked"` when scenario execution is interrupted by a mid-run infrastructure failure (NOT a static precondition — those remain `blocked`). Three documented mid-run triggers cover every observed case:

1. **Browser-open timeout >30s** — Playwright `browser_navigate` exceeds 30 seconds opening the browser window.
2. **Dev-server `ECONNREFUSED` or `EAI_AGAIN` mid-run** — Transport-layer failure on a previously-reachable dev-server endpoint.
3. **MCP tool ≥3 consecutive failures** — Any MCP tool fails three times in a row during scenario execution.

Contrast with `blocked` (static preconditions only): missing `mcp.json`, missing browser binaries, missing MCP servers — all detectable BEFORE scenarios begin.

### Flow A: Manual-tester emits `infra_blocked` mid-run

When one of the three triggers fires, the manual-tester:

1. Captures the trigger as a structured `InfraBlockedEvidence` payload:

   ```json
   {
     "timestamp": "<ISO 8601>",
     "narrative": "<human-readable trigger description, ≥10 chars>",
     "exception_trace": "<optional — present for transport/MCP triggers>",
     "dispatch_id": "<the manual-tester dispatch id>",
     "session_id": "<the current session id>"
   }
   ```

2. Returns `{result: "infra_blocked", scenario_count: <N>, pass_count: <N>, fail_count: 0, evidence_path: "<report path>", evidence: <payload>, top_residual_risk: "<one-line>"}` to the main agent.

### Flow B: Main-agent halt + audit-chain evidence + user surface

On receiving `result: "infra_blocked"`, the main agent:

1. Records the evidence atomically via:

   ```bash
   node .claude/scripts/session-checkpoint.mjs record-manual-test-result <sg-id> \
     --result infra_blocked \
     --scenario-count <N> --pass-count <N> --fail-count <N> \
     --evidence '<JSON payload from manual-tester>' \
     --dispatch-id '<dispatch id from manual-tester>'
   ```

   The validator (a) verifies the four-value enum admits `infra_blocked`, (b) verifies the structured evidence payload contains `timestamp`, `narrative`, `dispatch_id`, `session_id`, (c) verifies top-level `--dispatch-id` matches `evidence.dispatch_id` (rejects mismatch with a structured "dispatch_id mismatch" error), then (d) atomically writes `session.active_work.manual_test_result`, increments `session.active_work.dispatch_infra_blocked_count[dispatch_id]`, and appends the `manual_test_result_recorded` history entry plus the manifest `decision_log` entry — all in a single `saveSession` write.

2. Surfaces the `narrative`, `dispatch_id`, and `timestamp` to the operator with a pointer to the `evidence_path` for the full report.

3. Does NOT proceed to commit. The Stop-hook (which runs at session-completion attempt) reads `session.active_work.manual_test_result.result === "infra_blocked"` and emits a block reason `infra_blocked_terminal` containing the structured narrative.

4. Treats the halt as TERMINAL regardless of `runtime_validation_required`. Whereas `blocked` only blocks completion when `runtime_validation_required: true`, `infra_blocked` always blocks. This is the load-bearing distinction between the two values.

### Retry-bypass discipline

The first `infra_blocked` emission is terminal. The main agent does NOT silently retry per CLAUDE.md "Error Escalation Protocol" — infra failures are rarely transient at gate timescales (a 30-second browser-open window, a transport-level `ECONNREFUSED`, or three consecutive MCP failures are not noise that clears on retry).

Re-running `manual-tester` does NOT clear the `infra_blocked_terminal` block-reason. To resume after operator action (e.g., restart the dev server, reinstall Playwright browser binaries, fix the MCP plumbing), the operator MUST run:

```bash
node .claude/scripts/session-checkpoint.mjs clear-manual-test-result <sg-id>
```

This atomically deletes `session.active_work.manual_test_result` AND `session.active_work.dispatch_infra_blocked_count`, appends a `manual_test_result_cleared` history entry, mirrors the entry into the manifest `decision_log`, and clears the active `infra_blocked_terminal` Stop-hook block-reason (the block-reason is derived from session state, so clearing the state clears the block).

### ≥2-emission human-confirmation gate

When the same dispatch emits `infra_blocked` twice (the counter `session.active_work.dispatch_infra_blocked_count[dispatch_id] >= 2`), the Stop-hook adds an `infra_blocked_human_confirmation_required` block-reason ON TOP OF `infra_blocked_terminal`. The main agent surfaces BOTH narratives to the operator and MUST receive an explicit operator-typed acknowledgment before honoring the second halt.

The counter is keyed by `dispatch_id` AND scoped to the current phase. It is cleared (deleted, not zeroed) when the workflow transitions OUT of the `documenting` phase (the phase where `/manual-test` runs after `/docs`). Within `documenting`, halt-then-resume cycles sharing a `dispatch_id` accumulate the counter — the counter survives across re-dispatches in the same phase, so a second emission from a fixed-up infra issue still trips the gate.

### Operator-facing example

A complete halt-then-resume flow:

```
$ /manual-test sg-foo
[main-agent] dispatching manual-tester (dispatch_id=D1)
[manual-tester] scenario 3/10 — Playwright browser_navigate timed out after 30s
[manual-tester] returning result=infra_blocked, dispatch_id=D1, narrative="..."
[main-agent] recording evidence...
[main-agent] HALT: infra_blocked (D1, 2026-05-09T12:34:56Z)
[main-agent] narrative: "Playwright browser_navigate timed out at 30s on /dashboard scenario"
[main-agent] evidence_path: .claude/specs/groups/sg-foo/evidence/report.md
[main-agent] To resume: fix infra, then run `node .claude/scripts/session-checkpoint.mjs clear-manual-test-result sg-foo`

# Operator restarts dev server, reinstalls browser, then:
$ node .claude/scripts/session-checkpoint.mjs clear-manual-test-result sg-foo
[session-checkpoint] cleared manual_test_result and dispatch_infra_blocked_count for sg-foo

$ /manual-test sg-foo  # re-dispatch (operator may keep the same dispatch_id within the phase)
```

If the second dispatch ALSO returns `infra_blocked` with the same `dispatch_id=D1`, the counter increments to 2 and the human-confirmation gate trips on the next Stop-hook check.

## Report Format Summary

The narrative report has four required sections. This is the contract this skill enforces:

| Section            | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| **Scope**          | Which 10 scenarios were run; any reductions with rationale |
| **Evidence**       | Per-scenario artifact paths under `evidence/`              |
| **Findings**       | Observed vs. expected, pass/fail per scenario              |
| **Residual Risks** | What was NOT explored and why it might matter              |

## Patterns

### Pattern 1: Happy Path Probe

```javascript
// Navigate, observe, capture
(await mcp__playwright) -
  mcp__browser_navigate({ url: 'http://localhost:3000/dashboard' });
(await mcp__playwright) -
  mcp__browser_click({ element: 'logout button', ref: 'e1' });
(await mcp__playwright) - mcp__browser_wait_for({ text: 'Logged out' });
(await mcp__playwright) -
  mcp__browser_take_screenshot({ filename: 'evidence/happy-1-<ts>.png' });
```

### Pattern 2: Failure Injection

```javascript
// Inject failure via JS evaluate, then exercise the flow
(await mcp__playwright) -
  mcp__browser_evaluate({
    function:
      "() => { window.fetch = () => Promise.reject(new Error('Network')); }",
  });
(await mcp__playwright) -
  mcp__browser_click({ element: 'submit button', ref: 'e2' });
(await mcp__playwright) - mcp__browser_wait_for({ text: 'error' });
(await mcp__playwright) -
  mcp__browser_take_screenshot({ filename: 'evidence/failure-1-<ts>.png' });
```

### Pattern 3: Adjacent-Surface Probe via Bash

```bash
# Probe sibling endpoint that uses same code path
curl -s http://localhost:3000/api/adjacent-resource/42 | jq '.' > .claude/specs/groups/<sg-id>/evidence/adjacent-2-probe.json
```

### Pattern 4: Log Inspection After Failure

```bash
# Tail recent error-level entries
grep -i "error\|exception" /tmp/app.log | tail -20 > .claude/specs/groups/<sg-id>/evidence/failure-1-log.txt
```

## Best Practices

### Pin the Scenario List

Write the 10-scenario plan at the start. Do not add mid-run. If a scenario uncovers an unexpected branch, note it in Residual Risks and keep going.

### Prefer Realism to Exhaustiveness

Pick failure modes that _actually happen_: network drop, auth expiry, upstream 500, stale cache. Not contrived DOM manipulations.

### Adjacency Is a Budget

Two surfaces. Not "all neighbors." Pick the two most likely to regress — same component, same endpoint group, shared error path.

### Evidence Under `evidence/`

All artifacts go to `.claude/specs/groups/<sg-id>/evidence/`. Never to source, never to other spec groups, never to project root. Write discipline matters; an agent that writes outside its sandbox erodes the trust model that makes advisory dispatch safe.

### Stop When Done

Ten scenarios, then write the report, then return to main agent. Residual risks are surfaced in the report, not explored.

### No Destructive Tests on Production

Use `localhost` or explicit non-production URLs. Failure-injection on production is prohibited. This mirrors the existing constraint from the deleted `browser-tester` agent and carries forward intact.

## Integration with Other Skills

**Before manual testing** (must have completed):

- `/implement` — Implementation complete
- `/test` — Unit/integration tests passing
- `/e2e-test` — Generated E2E suite passing (unless `e2e_skip: true`)
- `/unify` — Spec-impl-test alignment validated
- `/code-review` — Code quality review passed
- `/security` — Security review passed
- completion-verifier — Post-completion gates passed
- `/docs` — Documentation generated

**After manual testing**: user reviews findings, then commit (or re-invoke `/implement` for fixes).

`/manual-test` is the **final step before commit** for spec-based workflows. Both `/docs/SKILL.md` "After docs" section and `/route/SKILL.md` workflow-integration rows list it in that position.

## Enforcement Invariant

This skill is advisory unless a spec explicitly opts into runtime validation:

- `manual-tester` is NOT in `STOP_MANDATORY_DISPATCHES`.
- Findings are logged to `session.subagent_tasks.completed_this_session[]` with `subagent_type: 'manual-tester'`.
- Unmarked specs remain advisory and do not block the Stop hook.
- Specs with `runtime_validation_required: true` block terminal Stop until `session.active_work.manual_test_result.result === "pass"` and the evidence path exists.
- There is no invocation counter, no cross-session state, and no "after N invocations promote to mandatory" mechanism.

## Example Invocation

```
/manual-test sg-logout-button
```

Skill:

1. Reads `.claude/specs/groups/sg-logout-button/spec.md`.
2. Identifies 10 scenarios (5 logout-happy + 3 logout-failure + 2 adjacent-auth-flows).
3. Dispatches `manual-tester` subagent with the scenario plan.
4. `manual-tester` exercises scenarios, captures evidence, writes report.
5. Returns status, outcome, evidence path, and top residual risk to main agent.
6. Main agent presents findings to user.

## Constraints

### DO

- Read spec group before dispatch.
- Pin the 10-scenario plan in advance.
- Dispatch `manual-tester` with the scenario list embedded in the prompt.
- Write all evidence to `.claude/specs/groups/<sg-id>/evidence/`.
- Record the structured result with `session-checkpoint.mjs record-manual-test-result`.

### DON'T

- Dispatch `manual-tester` earlier than the "After docs" phase.
- Duplicate `e2e-test-writer`'s contract-driven scope.
- Exceed 10 scenarios.
- Write outside `evidence/`.
- Flip any convergence field to true based on this skill's output.
- Treat narrative-only reports as sufficient for runtime-validation-required specs.

## Success Criteria

Manual testing is complete when:

- 10 scenarios exercised (or fewer, with documented reductions).
- Evidence artifacts written to `.claude/specs/groups/<sg-id>/evidence/`.
- Report written with Scope / Evidence / Findings / Residual Risks sections.
- Structured result recorded with `record-manual-test-result`.
- Agent summary returned to main agent with required status, evidence path, and residual risk fields.

For unmarked specs, findings are advisory. For runtime-validation-required specs, `fail` and `blocked` results stop terminal completion unless explicitly overridden with rationale.
