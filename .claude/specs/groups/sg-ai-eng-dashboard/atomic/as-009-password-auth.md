---
id: as-009-password-auth
title: Password Authentication
spec_group: sg-ai-eng-dashboard
requirements_refs: [REQ-009]
status: implemented
---

# Password Authentication

## References

- **Requirements**: REQ-009
- **Parent Spec Section**: spec.md#acceptance-criteria
- **Spec Group**: sg-ai-eng-dashboard

## Description

Implement password authentication for dashboard access. Unauthenticated users see login form. Password validated against bcrypt hash. Session token issued on success and persists across page refreshes.

## Acceptance Criteria

- **AC9.1**: Unauthenticated access redirects to /login
- **AC9.2**: Login form displays with password input and submit button
- **AC9.3**: Password validated against bcrypt hash stored in env
- **AC9.4**: Successful login issues secure httpOnly session cookie
- **AC9.5**: Session persists across page refreshes
- **AC9.6**: Invalid password shows error message
- **AC9.7**: Rate limiting: 5 attempts per minute, then 5-minute lockout
- **AC9.8**: Logout button clears session and redirects to /login

## Test Strategy

- Unit tests for login form validation
- Unit tests for bcrypt comparison
- Integration tests for session flow
- Rate limiting tests
- E2E test for full login/logout cycle

Test file: `apps/client-website/src/auth/__tests__/auth.test.ts`

## Deployment Notes

- PASSWORD_HASH environment variable required (bcrypt hash)
- SESSION_SECRET environment variable for cookie signing
- SESSION_EXPIRY_HOURS environment variable (default: 24 hours)

## Rollback Strategy

- Disable auth middleware, allow unauthenticated access temporarily
- Or revert to previous auth implementation if exists

## Atomicity Justification

| Criterion | Justification |
|-----------|---------------|
| **Independently Testable** | Can test auth flow in isolation with mocked storage |
| **Independently Deployable** | Auth can ship before other features |
| **Independently Reviewable** | Scope limited to auth logic and login UI |
| **Independently Reversible** | Disable auth check as quick rollback |

## Implementation Evidence

| File | Line | Description |
|------|------|-------------|
| `apps/node-server/src/handlers/dashboardLogin.handler.ts` | 1-108 | Dashboard login endpoint with bcrypt password verification (AC9.3, AC9.4, AC9.6) |
| `apps/node-server/src/handlers/dashboardLogout.handler.ts` | 1-46 | Dashboard logout endpoint that clears session cookie (AC9.8) |
| `apps/node-server/src/middleware/dashboardSession.middleware.ts` | 1-125 | Session validation middleware with HMAC-signed cookies (AC9.1, AC9.4, AC9.5) |
| `apps/node-server/src/middleware/dashboardRateLimiting.middleware.ts` | 1-162 | Rate limiting with 5 attempts/min and 5-minute lockout (AC9.7) |
| `apps/node-server/src/index.ts` | 61-70 | Route registration for auth endpoints |
| `apps/node-server/src/types/environment.ts` | 15-18 | Environment schema with PASSWORD_HASH, SESSION_SECRET, SESSION_EXPIRY_HOURS |
| `apps/client-website/src/app/login/page.tsx` | 1-151 | Login page with password-only form (AC9.2) |
| `apps/client-website/src/app/login/hooks.ts` | 1-90 | Login form hooks using dashboard auth (AC9.2, AC9.6) |
| `apps/client-website/src/lib/api/dashboardAuth.ts` | 1-127 | Dashboard auth API client with credentials |
| `apps/client-website/src/stores/dashboardAuthStore.ts` | 1-39 | Dashboard auth state store with persistence |
| `apps/client-website/src/hooks/useProtectedDashboard.ts` | 1-72 | Protected route hook that redirects to /login (AC9.1, AC9.5) |
| `apps/client-website/src/app/home/page.tsx` | 1-55 | Home page with logout button (AC9.8) |

## Test Evidence

| Test File | Test Name | ACs Covered |
|-----------|-----------|-------------|
| `apps/node-server/src/__tests__/handlers/dashboardLogin.handler.test.ts` | returns 200 and sets session cookie for valid password | AC9.3, AC9.4 |
| `apps/node-server/src/__tests__/handlers/dashboardLogin.handler.test.ts` | returns 401 for invalid password | AC9.6 |
| `apps/node-server/src/__tests__/handlers/dashboardLogin.handler.test.ts` | returns 400 when password is missing | AC9.2 |
| `apps/node-server/src/__tests__/middleware/dashboardRateLimiting.middleware.test.ts` | allows up to 5 attempts within a minute | AC9.7 |
| `apps/node-server/src/__tests__/middleware/dashboardRateLimiting.middleware.test.ts` | blocks 6th attempt and returns lockout time | AC9.7 |
| `apps/node-server/src/__tests__/middleware/dashboardRateLimiting.middleware.test.ts` | returns 429 when rate limited | AC9.7 |
| `apps/node-server/src/__tests__/middleware/dashboardSession.middleware.test.ts` | responds with 401 when session cookie is missing | AC9.1 |
| `apps/node-server/src/__tests__/middleware/dashboardSession.middleware.test.ts` | responds with 401 for expired session token | AC9.5 |
| `apps/node-server/src/__tests__/middleware/dashboardSession.middleware.test.ts` | calls next() for valid session token | AC9.4, AC9.5 |
| `apps/client-website/src/auth/__tests__/auth.test.ts` | sends password to login endpoint | AC9.2, AC9.3 |
| `apps/client-website/src/auth/__tests__/auth.test.ts` | throws error for invalid password | AC9.6 |
| `apps/client-website/src/auth/__tests__/auth.test.ts` | throws error for rate limiting | AC9.7 |
| `apps/client-website/src/auth/__tests__/auth.test.ts` | calls logout endpoint with credentials | AC9.8 |
| `apps/client-website/src/auth/__tests__/auth.test.ts` | validates password is required | AC9.2 |

## Decision Log

- `2026-01-17T20:50:00Z`: Created from spec.md decomposition
- `2026-01-17`: Implemented password-only dashboard authentication with bcryptjs for password hashing, HMAC-signed session cookies for session management, and in-memory rate limiting with 5-minute lockout after 5 failed attempts. Added SESSION_EXPIRY_HOURS environment variable for configurable session duration (default 24 hours).
