# Security Code Patterns

> Canonical reference for bad/good code examples across the 6 OWASP-adjacent pattern categories reviewed by the security-reviewer agent. `.claude/agents/security-reviewer.md` retains one canonical inline example (SQL injection) and delegates the remaining 5 categories to this file.

## Scope

Each pattern below shows a vulnerable snippet ("Bad") alongside a corrected snippet ("Good") plus an example finding format. These are reference examples, not exhaustive rules — see OWASP Top 10 for complete coverage.

Pattern categories covered:

1. [Input Validation](#input-validation)
2. [SQL Injection](#sql-injection) _(canonical example retained inline in `security-reviewer.md`; duplicated here for completeness)_
3. [Command Injection](#command-injection)
4. [Authentication & Authorization](#authentication--authorization)
5. [Secrets Handling](#secrets-handling)
6. [Data Protection & Logging](#data-protection--logging)

---

## Input Validation

**Checklist**:

- [ ] All user inputs validated with schemas
- [ ] Type validation (string, number, email)
- [ ] Length limits enforced
- [ ] Whitelist for enums

**Good**:

```typescript
const schema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});
const input = schema.parse(req.body);
```

**Bad**:

```typescript
const { email, password } = req.body; // No validation
```

**Finding template**:

```markdown
### Finding: Missing Input Validation (High)

- **File**: src/api/auth.ts:42
- **Issue**: Email not validated
- **Risk**: Injection, malformed data
- **Recommendation**: Add Zod validation
```

---

## SQL Injection

> Canonical example — also retained inline in `.claude/agents/security-reviewer.md` per DEC-004 (highest recognizability; parameterization pattern generalizes to other injection classes).

**Verify**:

- [ ] Parameterized queries used
- [ ] ORM used correctly
- [ ] No raw SQL with user input

**Good**:

```typescript
db.query('SELECT * FROM users WHERE email = $1', [email]);
```

**Bad**:

```typescript
db.query(`SELECT * FROM users WHERE email = '${email}'`); // CRITICAL
```

**Finding template**:

```markdown
### Finding: SQL Injection (CRITICAL)

- **File**: src/api/users.ts:34
- **Issue**: User input in SQL string
- **Risk**: CRITICAL - Database compromise
- **POC**: userId = "1 OR 1=1--"
- **Recommendation**: Use parameterized query
```

---

## Command Injection

**Verify**:

- [ ] No user input in shell commands
- [ ] Use `execFile` with array args (not `exec` with string interpolation)
- [ ] Whitelist validation

**Good**:

```typescript
import { execFile } from 'node:child_process';
execFile('/usr/bin/convert', [inputPath, outputPath]);
```

**Bad**:

```typescript
import { exec } from 'node:child_process';
exec(`convert ${inputPath} ${outputPath}`); // CRITICAL if inputPath is user-controlled
```

**Finding template**:

```markdown
### Finding: Command Injection (CRITICAL)

- **File**: src/api/convert.ts:18
- **Issue**: User-controlled input interpolated into shell command
- **Risk**: CRITICAL - Arbitrary command execution
- **Recommendation**: Use execFile with array args; validate against whitelist
```

---

## Authentication & Authorization

**Checklist**:

- [ ] Endpoints require authentication
- [ ] Authorization before data access
- [ ] No auth bypasses
- [ ] Tokens validated
- [ ] Sessions secure

**Good**:

```typescript
@Get("/profile")
@UseGuards(AuthGuard)
async getProfile(@CurrentUser() user: User) {
  return user.profile;
}
```

**Bad**:

```typescript
@Get("/profile") // No auth guard
async getProfile(@Query("userId") userId: string) {
  return db.getProfile(userId);
}
```

**Finding template**:

```markdown
### Finding: Missing Authentication (High)

- **File**: src/api/profile.ts:12
- **Issue**: Endpoint exposes user data without AuthGuard
- **Risk**: High - Horizontal data exposure
- **Recommendation**: Add @UseGuards(AuthGuard); derive userId from @CurrentUser()
```

---

## Secrets Handling

**Checklist**:

- [ ] No hardcoded secrets
- [ ] Environment variables used
- [ ] Secrets not logged
- [ ] PII encrypted at rest

**Good**:

```typescript
const apiKey = process.env.API_KEY;
```

**Bad**:

```typescript
const apiKey = 'sk_live_abc123'; // CRITICAL - Hardcoded
```

**Finding template**:

```markdown
### Finding: Hardcoded Secret (CRITICAL)

- **File**: src/config/api-client.ts:5
- **Issue**: Production API key committed to source
- **Risk**: CRITICAL - Credential exposure via repo access
- **Recommendation**: Move to environment variable; rotate exposed key
```

---

## Data Protection & Logging

**Checklist**:

- [ ] Passwords hashed (bcrypt, argon2)
- [ ] Sensitive data encrypted at rest
- [ ] HTTPS enforced
- [ ] No PII in logs
- [ ] No passwords/tokens logged

**Good**:

```typescript
logger.info('User logged in', { userId: user.id });
```

**Bad**:

```typescript
logger.info('Login', { email: user.email, password: pwd }); // CRITICAL
```

**Finding template**:

```markdown
### Finding: PII in Logs (High)

- **File**: src/services/auth.ts:42
- **Issue**: User email + password logged at INFO level
- **Risk**: High - PII exposure via log aggregation pipeline
- **Recommendation**: Log only non-reversible identifiers (user.id); never log secrets
```

---

## See Also

- `.claude/agents/security-reviewer.md` — security-reviewer agent with canonical SQL-injection example and pointer to this file
- `.claude/templates/threat-model.template.md` — STRIDE threat-model template
- `.claude/memory-bank/best-practices/ears-format.md` — generic EARS pattern templates
- OWASP Top 10 — https://owasp.org/www-project-top-ten/
