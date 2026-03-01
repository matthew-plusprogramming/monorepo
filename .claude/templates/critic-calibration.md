# Critic Calibration Set

> This file provides canonical severity examples for PRD critics. Each example includes a finding description, the ground-truth severity, and explicit reasoning for the classification. Critics should use these examples to calibrate their severity ratings.

## Severity Definitions

- **Critical**: Would cause architectural rework. The design is wrong, not just incomplete.
- **High**: Would cause significant code changes or feature redesign. Right thing, wrong way.
- **Medium**: Would cause localized fixes. Misses an edge case or secondary flow.
- **Low**: Easily inferred by a competent implementer. Nice-to-have clarity.

**The key question**: "Will the implementation team build the wrong thing (Critical/High) or just an incomplete thing (Medium/Low)?"

---

## Example 1: Missing Auth Model (Critical)

**Perspective**: Technical
**Finding**: PRD specifies "users can access their data" but does not define an authentication or authorization model. No mention of how users are identified, what auth tokens look like, or how permissions are enforced.
**Severity**: Critical
**Reasoning**: Without an auth model, the implementation team must guess at the entire security architecture. Different implementers will make different assumptions (JWT vs session, role-based vs attribute-based). This would require architectural rework when the actual auth model is decided. The design is fundamentally incomplete, not just missing a detail.

_Inspired by Scenario A (JWT vs session-based auth drift)_

---

## Example 2: Contradictory Acceptance Criteria (High)

**Perspective**: Business
**Finding**: PRD states SC-1 "System must respond in under 200ms" but also states SC-5 "All responses must include full audit trail with historical data." Loading historical audit data for every response is incompatible with the 200ms target for large accounts.
**Severity**: High
**Reasoning**: The implementation team would build toward one criterion and discover it conflicts with the other during integration testing. This is the right set of features but the wrong constraints -- one must be relaxed or the architecture must accommodate both (caching, lazy loading). Significant code changes required once the contradiction surfaces.

_Inspired by Scenario D (spec-is-wrong pushback)_

---

## Example 3: Undefined Error Response Shape (High)

**Perspective**: Technical
**Finding**: PRD describes 5 API endpoints but does not specify the error response format. No mention of error codes, error message structure, or HTTP status code mapping.
**Severity**: High
**Reasoning**: Every team consuming the API will assume a different error shape. Dev might use `{ error: string }`, QA might test for `{ error: { code: number, message: string } }`, and documentation will describe yet another format. This causes significant rework across multiple consumers when the shape is standardized.

_Inspired by Scenario B (implicit assumption conflict on error shapes)_

---

## Example 4: Missing Failure Mode for External Dependency (Medium)

**Perspective**: Edge Case
**Finding**: PRD describes integration with a third-party payment processor but does not address what happens when the payment processor is unavailable (timeout, 5xx errors, network partition).
**Severity**: Medium
**Reasoning**: The happy path is clear -- the implementation team knows what to build. But the failure handling is missing. This would cause localized fixes: adding retry logic, timeout handling, and user-facing error messages for the payment flow. The core architecture is sound; the edge case needs filling in.

_Inspired by Scenario I (multiple simultaneous gaps)_

---

## Example 5: Ambiguous File Upload Scope (Medium)

**Perspective**: Business
**Finding**: PRD says "users can upload files" without specifying single vs. multi-file upload, maximum file size, allowed file types, or drag-and-drop support.
**Severity**: Medium
**Reasoning**: The feature intent is clear (file upload exists), but the scope is ambiguous. Different implementers might build single-file upload while QA tests multi-file drag-and-drop. This is a localized scope clarification, not an architectural gap -- the upload infrastructure is the same regardless.

_Inspired by Scenario M (ambiguity that looks clear)_

---

## Example 6: Missing Pagination Details (Medium/Low -- Borderline)

**Perspective**: Technical
**Finding**: PRD specifies "display list of user projects" but does not mention pagination, sorting, or filtering. The list could grow to thousands of items.
**Severity**: Medium
**Reasoning for Medium (not Low)**: While a competent implementer would add pagination, the PRD's silence creates ambiguity about cursor vs. offset pagination, default page size, sort order, and filter dimensions. These choices affect API contract design and frontend state management. If the PRD had said "display a paginated list" this would be Low -- the specific implementation is inferrable. But complete silence on list handling for a potentially large dataset crosses into Medium territory because the API contract decisions compound.

_This is a borderline Medium/Low case. The deciding factor: does the PRD acknowledge the list could be large? If yes and pagination is simply unspecified, that's Low. If the PRD doesn't acknowledge scale at all, that's Medium._

---

## Example 7: Unspecified Log Level (Low)

**Perspective**: Technical
**Finding**: PRD says "system shall log all authentication events" but does not specify the log level (info, debug, warn) or log format (structured JSON vs. plain text).
**Severity**: Low
**Reasoning**: A competent implementer would use structured JSON at info level, following codebase conventions. The PRD correctly identifies WHAT to log (auth events) and WHY (audit trail). The HOW (log level, format) is an implementation detail that follows from established patterns. No architectural or design decisions are affected.

---

## Example 8: Missing Tooltip Text (Low -- Borderline)

**Perspective**: Edge Case
**Finding**: PRD describes a dashboard with 12 metric cards but does not specify tooltip text for each metric. Users may not understand what "P95 Latency" or "Error Budget" means.
**Severity**: Low
**Reasoning for Low (not Medium)**: Tooltip text is easily inferred from metric names and industry conventions. A competent implementer or technical writer would produce reasonable tooltips. The user experience is slightly degraded without explicit text, but the feature functions correctly. The PRD's silence on tooltips does not create ambiguity about the feature's behavior or architecture.

_This is a borderline Medium/Low case. The deciding factor: do the tooltips affect user understanding of the core feature? For a developer-facing dashboard, metric names are self-explanatory (Low). For a consumer-facing dashboard where users don't know the terminology, missing tooltips would be Medium because users can't use the feature effectively._

---

## Calibration Summary

| #   | Perspective | Severity            | Key Signal                                              |
| --- | ----------- | ------------------- | ------------------------------------------------------- |
| 1   | Technical   | Critical            | Missing foundational architecture decision (auth model) |
| 2   | Business    | High                | Internal contradiction between acceptance criteria      |
| 3   | Technical   | High                | Missing cross-team contract (error shape)               |
| 4   | Edge Case   | Medium              | Missing failure handling for known dependency           |
| 5   | Business    | Medium              | Ambiguous scope for user-facing feature                 |
| 6   | Technical   | Medium (borderline) | Silent on scale-dependent design decision               |
| 7   | Technical   | Low                 | Implementation detail following codebase conventions    |
| 8   | Edge Case   | Low (borderline)    | Missing nice-to-have content, feature works without it  |

**Borderline cases (6 and 8)**: The examples above include explicit reasoning for why the borderline was drawn where it was. Critics should use similar reasoning when encountering findings that could be either Medium or Low.
