---
Title: Code Review Workflow
---

Intent

- Supply a reliable, repeatable process for AI-led code reviews that surface actionable findings, respect project guardrails, and keep reviewers aligned on severity and merge guidance.

Global Prompts

- Retrieval: Load context per `agents/memory-bank.md` (workflow, brief, progress log, active context, optional tech/system patterns when substantive).
- Discovery tools: Prefer `node agents/scripts/list-files-recursively.mjs` and `node agents/scripts/smart-file-query.mjs` for enumerating files and reading contents instead of falling back to generic shell commands.
- Tone: Be constructive, specific, and solution-oriented; prefer "Consider ... because ..." to blunt rejections.
- Safety: Default to caution when unsure; flag uncertainty explicitly rather than guessing.

Phase: plan

- Goal: Gather all relevant inputs and validate readiness before judging the change.
- Inputs: Request description, specs or tickets, proposed diff/patch, commit message, CI/test outputs, style and security guidelines, architectural docs, Memory Bank context, prior discussions.
- Checklist:
  - Confirm diff coverage: include modified files, deleted/added assets, generated artifacts, config migrations.
  - Capture intent: restate author’s goal(s) and constraints; log assumptions in working notes.
  - Collect supporting signals: CI/test status, lint/static analysis, dependency versions, rollout plans.
  - Identify missing or ambiguous context; when gaps exist, decide to (a) ask for clarification, (b) proceed conservatively noting risk, or (c) block approval if correctness cannot be assessed.
  - Note areas needing focused scrutiny (new entry points, security/privacy boundaries, heavy resource usage).
- Outputs: Context brief (intent, scope, assumptions), list of gathered artifacts, outstanding questions or risks.
- Next: build

Phase: build

- Goal: Evaluate the change end-to-end, log findings with severities, and propose actionable remedies.
- Checklist:
  - Understand the diff: walk through flow of data and control; map new/changed interfaces and invariants.
  - Automated signals: review CI/logs first; if missing or failing, document impact and treat unresolved failures as blockers.
  - Review dimensions:
    - Correctness & readability: verify logic, state management, edge cases, clarity, maintainability, adherence to established patterns.
    - Security & privacy: look for injection, XSS, auth, access control, data exposure, secret handling, compliance boundaries.
    - Reliability & performance: assess error handling, resilience, resource usage, concurrency, scalability.
    - Testing & documentation: check that automated tests cover new paths/boundaries, docs/guides/configs stay consistent, and manual steps are documented.
  - For each issue, capture: severity (see rubric), location (file:line), observed behavior, expected behavior, and a concrete recommendation.
  - Propose positive observations when changes improve the system or resolve prior debt; reinforce good patterns.
- Severity Rubric & Merge Guidance:
  - Critical -- Exploitable security/privacy flaw, data loss, guaranteed crash, or legal/compliance violation. Must block merge.
  - Major -- High likelihood of incorrect behavior, severe performance regression, missing essential tests/docs, or unresolved CI failure. Block merge until fixed.
  - Minor -- Localized bug, unclear naming, maintainability concern, or test/doc gap with workarounds. Request fix but merge may wait for follow-up if risk is low.
  - Nit -- Style/tone/consistency polish or subjective preference. Offer optional suggestion; never block merge.
- Outputs: Draft findings grouped by severity, inline comment targets, unresolved questions, highlights of strengths.
- Next: verify

Phase: verify

- Goal: Finalize the review package, ensure guardrails are met, and publish concise guidance.
- Checklist:
  - Confirm every review dimension lists either "no issues" or explicit findings; avoid silent omissions.
  - Cross-check severity assignments against rubric; upgrade uncertainty to higher severity or call out as blocking question.
  - Compose the review response:
    - Summary: intent restatement, overall verdict (approve/changes requested/block), top findings.
    - Findings: bullet per issue with severity tag, file:line, evidence, and recommended fix.
    - Inline-ready notes: prepare comments that map directly to diff locations.
    - Checklist: state CI status, tests observed/missing, risk areas inspected, open questions.
    - Confidence statement: name any assumptions or remaining doubts.
  - Ensure tone stays respectful, collaborative, and specific; avoid vague language ("looks wrong").
  - Verify no fabricated evidence or unstated checks; if something was not inspected, say so.
  - Update Memory Bank artifacts and reflections per repo policy after delivering the review.
- Outputs: Publishable review message, inline comment plan, updated Memory Bank notes.
- Next: done

Guardrails

- Do not fabricate or infer results without evidence; mark missing data and recommend follow-up.
- Do not refactor or request changes unrelated to the diff’s scope unless they introduce risk.
- Default to blocking when correctness, security, or compliance cannot be validated.
- Escalate and seek clarification when encountering novel patterns or requirements outside documented policies.
- Record uncertainty clearly and prefer actionable questions over assumptions.

End

- Close with concise recap of decision, key blockers (if any), and suggested next steps for the author.
