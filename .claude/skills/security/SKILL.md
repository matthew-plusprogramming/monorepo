---
name: security
description: Review implementation for security vulnerabilities and best practices. Checks input validation, injection prevention, auth/authz, secrets handling. Use after implementation before merge.
allowed-tools: Read, Glob, Grep
---

# Security Review Skill

## Purpose

Review implementation for security vulnerabilities before approval. Produce pass/fail report with findings and recommendations.

## When to Use

Mandatory for:

- Any feature handling user input
- Authentication or authorization changes
- API endpoints or data access
- File system operations
- Database queries
- External API calls
- Cryptographic operations

Optional for:

- Pure UI changes with no data handling
- Documentation updates
- Test-only changes

## Security Review Process

### Step 1: Load Spec and Implementation

```bash
# Load spec to understand requirements
cat .claude/specs/active/<slug>.md

# Find implementation files
grep -r "class\|function\|const" src/ --include="*.ts" -l
```

Identify:

- Entry points (API routes, event handlers)
- Data flows (input → processing → output)
- External boundaries (user input, APIs, database)

### Step 2: Input Validation Review

Check all user inputs are validated:

```bash
# Find input sources
grep -r "req.body\|req.query\|req.params" src/ --include="*.ts"

# Check for validation
grep -r "z\.\|Zod\|validate" src/ --include="*.ts"
```

#### Validation Checklist

- [ ] All user inputs validated with schemas (Zod, Joi, etc.)
- [ ] Type validation (string, number, email, URL)
- [ ] Length limits enforced
- [ ] Whitelist validation for enums
- [ ] No raw user input passed to dangerous functions

**Good**:

```typescript
// Input validated with Zod
const LoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});

const input = LoginSchema.parse(req.body);
```

**Bad**:

```typescript
// No validation - vulnerable
const { email, password } = req.body;
login(email, password);
```

#### Findings Format

```markdown
### Finding 1: Missing Input Validation (High)

- **File**: src/api/auth.ts:42
- **Issue**: Email not validated before use
- **Risk**: Injection attacks, malformed data
- **Recommendation**: Add Zod schema validation
```

### Step 3: Injection Prevention Review

Check for SQL injection, command injection, XSS.

#### SQL Injection

```bash
# Find database queries
grep -r "db.query\|db.raw\|sql\`" src/ --include="*.ts"
```

Verify:

- [ ] Parameterized queries used (never string concatenation)
- [ ] ORM used correctly (Prisma, TypeORM)
- [ ] No raw SQL with user input

**Good**:

```typescript
// Parameterized query
const user = await db.query('SELECT * FROM users WHERE email = $1', [email]);
```

**Bad**:

```typescript
// SQL injection vulnerable
const user = await db.query(`SELECT * FROM users WHERE email = '${email}'`);
```

#### Command Injection

```bash
# Find shell commands
grep -r "exec\|spawn\|execFile" src/ --include="*.ts"
```

Verify:

- [ ] No user input in shell commands
- [ ] If necessary, use `execFile` with array args (not `exec`)
- [ ] Whitelist validation for any user-controlled values

**Good**:

```typescript
// Safe - no shell, array args
execFile('convert', ['-resize', '100x100', inputPath, outputPath]);
```

**Bad**:

```typescript
// Command injection vulnerable
exec(`convert -resize 100x100 ${inputPath} ${outputPath}`);
```

#### XSS (Cross-Site Scripting)

```bash
# Find HTML rendering
grep -r "innerHTML\|dangerouslySetInnerHTML" src/ --include="*.tsx"
```

Verify:

- [ ] User input properly escaped
- [ ] No `dangerouslySetInnerHTML` with user content
- [ ] Framework escaping used (React, Vue auto-escape)
- [ ] Content Security Policy headers set

**Good**:

```tsx
// React auto-escapes
<div>{userInput}</div>
```

**Bad**:

```tsx
// XSS vulnerable
<div dangerouslySetInnerHTML={{ __html: userInput }} />
```

### Step 4: Authentication & Authorization Review

Check auth is properly enforced.

```bash
# Find auth middleware
grep -r "authenticate\|authorize\|requireAuth" src/ --include="*.ts"

# Find protected routes
grep -r "router\.\|app\.\|@Get\|@Post" src/ --include="*.ts"
```

#### Auth Checklist

- [ ] Endpoints require authentication (except public routes)
- [ ] Authorization checks before data access
- [ ] No auth bypasses (e.g., `if (user || true)`)
- [ ] Tokens validated on every request
- [ ] Session management secure (httpOnly cookies, SameSite)

**Good**:

```typescript
// Auth required
@Get("/profile")
@UseGuards(AuthGuard)
async getProfile(@CurrentUser() user: User) {
  return user.profile;
}
```

**Bad**:

```typescript
// No auth - anyone can access
@Get("/profile")
async getProfile(@Query("userId") userId: string) {
  return db.getProfile(userId);
}
```

### Step 5: Secrets & Sensitive Data Review

Check secrets are not exposed.

```bash
# Find potential secrets
grep -r "password\|secret\|key\|token" src/ --include="*.ts"

# Check for hardcoded secrets
grep -r "\".*secret.*\"\|'.*secret.*'" src/ --include="*.ts"
```

#### Secrets Checklist

- [ ] No hardcoded secrets (API keys, passwords)
- [ ] Environment variables used for secrets
- [ ] Secrets not logged
- [ ] Secrets not sent to client
- [ ] PII (Personally Identifiable Information) encrypted at rest

**Good**:

```typescript
// Secret from environment
const apiKey = process.env.API_KEY;

// PII encrypted
const user = await db.user.create({
  data: {
    email: email,
    ssn: encrypt(ssn), // Encrypted before storage
  },
});
```

**Bad**:

```typescript
// Hardcoded secret
const apiKey = 'sk_live_abc123def456';

// PII logged
console.log(`User SSN: ${user.ssn}`);
```

### Step 6: Data Protection Review

Check sensitive data is protected.

#### Encryption

- [ ] Passwords hashed (bcrypt, argon2, scrypt)
- [ ] Sensitive data encrypted at rest
- [ ] HTTPS enforced for transport

#### Logging

```bash
# Find logging statements
grep -r "console.log\|logger\." src/ --include="*.ts"
```

Verify:

- [ ] No PII in logs (emails, SSNs, credit cards)
- [ ] No passwords or tokens in logs
- [ ] Error messages don't leak sensitive info

**Good**:

```typescript
// Safe logging
logger.info('User login successful', { userId: user.id });
```

**Bad**:

```typescript
// Sensitive data in logs
logger.info('User logged in', { email: user.email, password: user.password });
```

### Step 7: Dependency Security Review

Check for vulnerable dependencies.

```bash
# Run security audit
npm audit

# Check for high/critical vulnerabilities
npm audit --audit-level=high
```

#### Dependency Checklist

- [ ] No known critical vulnerabilities
- [ ] Dependencies up to date
- [ ] Minimal dependency surface (only necessary packages)
- [ ] Lock file committed (package-lock.json)

### Step 8: Generate Security Report

Aggregate findings into security report.

````markdown
# Security Review Report: <Task Name>

**Date**: 2026-01-02 17:00
**Reviewer**: security-reviewer
**Spec**: .claude/specs/active/logout-button.md

## Summary: ✅ PASS

No critical or high-severity issues found. 1 medium-severity recommendation.

---

## Findings

### Medium Severity

#### Finding 1: Weak Error Message

- **File**: src/services/auth-service.ts:47
- **Issue**: Error message "Logout failed. Please try again." doesn't indicate cause
- **Risk**: Medium - User confusion, but no security impact
- **Recommendation**: Add specific error codes without leaking sensitive info

```typescript
// Recommended
catch (error) {
  if (error.code === 'NETWORK_ERROR') {
    throw new Error('Unable to connect. Check your network.');
  } else {
    throw new Error('Logout failed. Please try again.');
  }
}
```
````

---

## Security Checklist

### Input Validation: ✅ Pass

- No user input in logout flow
- N/A

### Injection Prevention: ✅ Pass

- No SQL queries
- No shell commands
- No HTML rendering

### Authentication & Authorization: ✅ Pass

- Logout endpoint properly authenticated
- Token cleared after server confirms logout
- No auth bypasses

### Secrets & Sensitive Data: ✅ Pass

- No secrets in code
- Token cleared from localStorage
- No sensitive data logged

### Data Protection: ✅ Pass

- No PII handled in this feature
- Error messages generic

### Dependencies: ✅ Pass

- No new dependencies added
- Existing deps: 0 vulnerabilities

---

## Approval: ✅ CAN PROCEED

**Status**: Pass with recommendations

**Next Steps**:

1. Address medium-severity finding (optional)
2. Proceed to browser testing (if applicable)
3. Ready for commit

````

### Step 9: Handle Security Failures

If critical or high-severity issues found:

```markdown
## Summary: ❌ FAIL

**Critical issues found. DO NOT MERGE.**

---

## Critical Findings

### Finding 1: SQL Injection Vulnerability (Critical)
- **File**: src/api/users.ts:34
- **Issue**: User input directly concatenated into SQL query
- **Risk**: CRITICAL - Attacker can access/modify entire database
- **POC**: `userId = "1 OR 1=1--"` returns all users
- **Recommendation**: Use parameterized query immediately
```typescript
// Fix required
const user = await db.query(
  "SELECT * FROM users WHERE id = $1",
  [userId]  // Parameterized
);
````

**Action**: STOP - Fix critical issues before proceeding.

````

Status levels:
- **Critical**: Immediate data breach or system compromise risk
- **High**: Significant security risk, should be fixed before merge
- **Medium**: Security concern, should be addressed soon
- **Low**: Best practice improvement, nice to have

### Step 10: Record Security Approval

Add to spec's Decision & Work Log:

```markdown
## Decision & Work Log

- 2026-01-02 17:00: Security review completed
  - Status: PASS
  - Findings: 0 critical, 0 high, 1 medium
  - Reviewer: security-reviewer subagent
  - Approval: Can proceed to merge
````

## Common Vulnerabilities to Check

### OWASP Top 10

1. **Injection** (SQL, NoSQL, Command, LDAP)
2. **Broken Authentication**
3. **Sensitive Data Exposure**
4. **XML External Entities (XXE)**
5. **Broken Access Control**
6. **Security Misconfiguration**
7. **Cross-Site Scripting (XSS)**
8. **Insecure Deserialization**
9. **Using Components with Known Vulnerabilities**
10. **Insufficient Logging & Monitoring**

## Integration with Other Skills

After security review:

- If PASS → Proceed to browser testing or commit
- If FAIL → Use `/implement` to fix issues, then re-review

Before security review:

- Run `/unify` to ensure spec-impl-test convergence
- Security review is final gate before approval

## Examples

### Example 1: Pass with No Findings

**Input**: Logout button implementation (no user input, no data access)

**Security Review**:

- Input validation: N/A (no user input)
- Injection: N/A (no queries)
- Auth: ✅ Endpoint authenticated
- Secrets: ✅ None exposed
- Data protection: ✅ Token cleared

**Output**: ✅ PASS - No findings, ready for merge

### Example 2: Fail - SQL Injection

**Input**: User search endpoint with SQL injection

**Security Review**:

- Input validation: ❌ No validation
- Injection: ❌ CRITICAL - SQL injection in search query

**Output**:

```markdown
❌ FAIL - Critical SQL injection vulnerability

**Finding**: User input directly in SQL query
**File**: src/api/search.ts:12
**Fix**: Use parameterized query

DO NOT MERGE until fixed.
```

**Action**: Fix SQL injection → Re-run security review → Pass

### Example 3: Pass with Recommendations

**Input**: Login endpoint with weak password requirements

**Security Review**:

- Input validation: ⚠️ Medium - Min password length is 6 (recommend 8)
- Injection: ✅ Pass
- Auth: ✅ Pass
- Secrets: ✅ Pass

**Output**:

```markdown
✅ PASS with recommendations

**Finding (Medium)**: Weak password requirements
**Recommendation**: Increase minimum password length to 8 characters

Can proceed to merge, but recommend addressing finding in future iteration.
```
