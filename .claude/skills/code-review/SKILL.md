---
name: code-review
description: Review implementation for code quality, style consistency, and best practices. Runs before security review. READ-ONLY - reports issues but does not fix them.
allowed-tools: Read, Glob, Grep
---

# Code Review Skill

## Purpose

Review implementation for quality issues before security review. Catch maintainability problems, style inconsistencies, and best practice violations. Produce pass/fail report with findings.

## When to Use

**Mandatory for**:
- Any implementation completing the spec workflow
- Multi-file changes
- Public API additions or modifications
- Changes to core services

**Optional for**:
- Single-file bug fixes
- Documentation-only changes
- Test-only changes
- Configuration changes

## Review Pipeline Position

```
Implementation → Code Review → Security Review → Merge
                    ↑
                You are here
```

Code Review runs BEFORE Security Review because:
- Quality issues may mask security issues
- Consistent code is easier to security-review
- Catches different class of problems

## Code Review Process

### Step 1: Load Review Context

```bash
# What was implemented
cat .claude/specs/active/<slug>.md

# What files changed
git diff --name-only main..HEAD

# Read changed files
git diff main..HEAD -- src/
```

### Step 2: Review Categories

Check each category systematically:

#### A. Code Style & Consistency

- Naming conventions (camelCase, PascalCase per project standard)
- File organization (imports, exports, structure)
- Formatting consistency
- Comment quality (useful vs obvious vs missing)

#### B. Code Quality & Maintainability

- Function length (>50 lines is suspect)
- Cyclomatic complexity (>10 is suspect)
- Deep nesting (>3 levels is suspect)
- Code duplication
- Dead code
- Magic numbers/strings

#### C. TypeScript Best Practices

- `any` usage (should be rare and justified)
- Missing return types on public methods
- Proper null/undefined handling
- Generic usage appropriateness
- Type assertions (`as`) overuse

#### D. Error Handling

- Empty catch blocks
- Swallowed errors (catch and return null)
- Missing error types
- Inconsistent error handling patterns
- Error messages quality

#### E. API Design

- Inconsistent parameter ordering
- Missing or inconsistent return types
- Breaking changes to public API
- Undocumented public methods

#### F. Testing Gaps

- Public methods without tests
- Edge cases not covered
- Test quality (meaningful assertions)
- Test isolation (no shared state)

### Step 3: Severity Classification

| Level | Meaning | Blocks Merge |
|-------|---------|--------------|
| **Critical** | Will cause runtime failure | Yes |
| **High** | Significant maintainability issue | Yes |
| **Medium** | Should fix but not blocking | No |
| **Low** | Suggestion for improvement | No |

### Step 4: Generate Review Report

```markdown
## Code Review Report

**Spec**: .claude/specs/active/<slug>.md
**Files Reviewed**: 6
**Review Date**: 2026-01-08

### Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 3 |

**Verdict**: ✅ PASS

### Findings

#### Medium Severity

**M1: Function too long**
- **File**: src/services/order.ts:45-120
- **Issue**: `processOrder` is 75 lines with 8 branches
- **Impact**: Hard to test, hard to modify safely
- **Suggestion**: Extract validation and calculation into separate methods

**M2: Missing return type**
- **File**: src/api/users.ts:34
- **Issue**: `getUserProfile` has no return type annotation
- **Impact**: Type safety lost for consumers
- **Suggestion**: Add `Promise<UserProfile>` return type

#### Low Severity

[... suggestions ...]

### Positive Observations

- Good test coverage on new AuthService methods
- Consistent use of Result type pattern
- Clear separation of concerns in handlers

### Recommendations

1. Consider extracting validation logic (M1) in follow-up
2. Add JSDoc to public APIs (L1, L2) for better DX
```

### Step 5: Handle Blocking Issues

If Critical or High severity issues found:

```markdown
## Code Review Report

**Verdict**: ❌ BLOCKED (2 High severity issues)

### Blocking Issues

**H1: Swallowed exception in payment processing**
- **File**: src/services/payment.ts:78
- **Issue**: Catch block returns null, hiding failure cause
- **Impact**: Payment failures will be silent, hard to debug
- **Required Fix**: Throw PaymentError with cause chain

**H2: Type assertion without validation**
- **File**: src/api/handlers.ts:34
- **Issue**: `response as UserData` without validation
- **Impact**: Runtime type errors possible
- **Required Fix**: Use type guard or schema validation

**Action**: Fix blocking issues, then re-run code review.
```

### Step 6: Record Review Approval

Add to spec's Decision & Work Log:

```markdown
## Decision & Work Log

- 2026-01-08 14:00: Code review completed
  - Status: PASS
  - Findings: 0 critical, 0 high, 2 medium, 3 low
  - Reviewer: code-reviewer subagent
  - Approval: Can proceed to security review
```

## Review Guidelines

### Be Specific and Actionable

**Bad**:
```markdown
Code quality could be better in auth.ts
```

**Good**:
```markdown
**Quality: Function too long** (Medium)
- File: src/services/auth.ts:45-120
- Issue: `validateSession` is 75 lines with 8 branches
- Impact: Hard to test, hard to modify safely
- Suggestion: Extract token parsing (L45-65) and permission check (L80-100)
```

### Distinguish Standards from Opinions

**Standard** (objective):
```markdown
TypeScript: Missing return type on public method
```

**Opinion** (subjective):
```markdown
Style suggestion: Consider using early returns for readability
```

Mark opinions clearly so implementer can prioritize.

### Acknowledge Good Patterns

Include positive observations:
- Well-structured code
- Good test coverage
- Clever but readable solutions

### Scope to Changes

Review what changed, not the entire codebase.

**In scope**: Files modified in this implementation
**Out of scope**: Pre-existing issues in unchanged files

Note pre-existing issues as "Pre-existing" - they don't block merge.

## Review Checklist

For each changed file:

```markdown
□ Naming follows project conventions
□ No obvious code duplication
□ Functions are reasonably sized (<50 lines)
□ Nesting depth acceptable (<4 levels)
□ Error handling is consistent
□ No `any` without justification
□ Public APIs have return types
□ No dead code introduced
□ No magic numbers/strings
□ Tests exist for new public methods
```

## Integration with Other Skills

**Before code review**:
- `/unify` to ensure spec-impl-test convergence

**After code review**:
- If PASS → Proceed to `/security`
- If BLOCKED → Use `/implement` to fix issues, then re-review

**Full review chain after code-review**:
1. `/security` - Security review (always)
2. `/browser-test` - UI validation (if UI changes)
3. `/docs` - Documentation generation (if public API)
4. Commit

## Constraints

### READ-ONLY

You report findings but do not modify code. Let Implementer fix issues.

### Not Security Review

Focus on code quality. Security Reviewer handles:
- Injection vulnerabilities
- Authentication/authorization flaws
- Secrets exposure
- OWASP Top 10

Flag obvious security issues, but security review is the comprehensive check.

## Examples

### Example 1: Clean Pass

**Input**: Well-structured logout implementation

**Review**:
- Style: ✅ Consistent naming
- Quality: ✅ Functions <50 lines
- TypeScript: ✅ Return types present
- Error handling: ✅ Consistent pattern
- Testing: ✅ All ACs covered

**Output**: ✅ PASS - No findings, proceed to security review

### Example 2: Pass with Recommendations

**Input**: Feature implementation with minor issues

**Review**:
- 2 Medium findings (long function, missing JSDoc)
- 3 Low findings (style suggestions)

**Output**: ✅ PASS with recommendations - Proceed, address in follow-up

### Example 3: Blocked

**Input**: Implementation with swallowed exceptions

**Review**:
- 1 High finding (swallowed exception hides payment failures)

**Output**: ❌ BLOCKED - Fix H1 before proceeding
