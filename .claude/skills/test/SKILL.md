---
name: test
description: Write tests that verify spec acceptance criteria and requirements. Maps each AC to specific test cases, follows AAA pattern, ensures deterministic isolated tests. Use in parallel with implementation or after.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Test Writing Skill

## Purpose

Write tests that verify spec requirements with full traceability to acceptance criteria. Tests serve as executable validation of the spec contract.

## Testing Philosophy

### Tests Verify Spec, Not Implementation

- Tests should validate **what** the system does (behavior)
- Not **how** it does it (implementation details)
- If implementation changes but behavior stays the same, tests should still pass

### One Test Per Acceptance Criterion (Minimum)

- Each AC in spec gets at least one test
- Complex ACs may need multiple tests
- Test name references AC for traceability

### AAA Pattern (Arrange-Act-Assert)

Always structure tests with comments:

```typescript
it('should clear token on logout', () => {
  // Arrange
  const authService = new AuthService();
  authService.setToken('test-token');

  // Act
  authService.logout();

  // Assert
  expect(localStorage.getItem('auth_token')).toBeNull();
});
```

## Test Writing Process

### Step 1: Load Spec

```bash
cat .claude/specs/active/<slug>.md
```

Extract:

- All acceptance criteria (AC1.1, AC1.2, etc.)
- Requirements (EARS format)
- Edge cases
- Error conditions

### Step 2: Identify Test Locations

Determine where tests should live:

```bash
# Find existing test patterns
glob "**/*.test.ts"

# Check for related tests
grep -r "describe.*Auth" --include="*.test.ts"
```

Follow project conventions:

- Unit tests: `src/**/__tests__/*.test.ts` or co-located `*.test.ts`
- Integration tests: `tests/integration/*.test.ts`
- E2E tests: `tests/e2e/*.test.ts`

### Step 3: Review Existing Test Patterns

Study how tests are written in this codebase:

```bash
# Read a representative test file
cat src/services/__tests__/auth.test.ts
```

Note:

- Test framework (Jest, Vitest, Mocha)
- Assertion library (expect, assert)
- Mocking approach (jest.mock, vi.mock)
- Builder patterns or factories
- Setup/teardown patterns

### Step 4: Map ACs to Test Cases

For each acceptance criterion, create test case(s):

**From spec**:

```markdown
## Acceptance Criteria

- AC1.1: Logout button clears authentication token
- AC1.2: User is redirected to login page after logout
- AC1.3: Confirmation message is displayed
- AC2.1: Network error shows error message
```

**Test mapping**:

```markdown
## Test Plan

| AC    | Test File              | Test Case                                |
| ----- | ---------------------- | ---------------------------------------- |
| AC1.1 | `auth-service.test.ts` | "should clear token on logout"           |
| AC1.2 | `auth-router.test.ts`  | "should redirect to /login after logout" |
| AC1.3 | `user-menu.test.ts`    | "should show confirmation toast"         |
| AC2.1 | `auth-service.test.ts` | "should show error on network failure"   |
```

### Step 5: Write Tests Following AAA Pattern

For each test case:

```typescript
describe('AuthService', () => {
  describe('logout', () => {
    it('should clear token on logout (AC1.1)', () => {
      // Arrange - Set up test state
      const authService = new AuthService();
      localStorage.setItem('auth_token', 'test-token');

      // Act - Execute the behavior
      await authService.logout();

      // Assert - Verify the outcome
      expect(localStorage.getItem('auth_token')).toBeNull();
    });

    it('should show error on network failure (AC2.1)', () => {
      // Arrange
      const authService = new AuthService();
      const mockApi = {
        post: jest.fn().mockRejectedValue(new Error('Network error')),
      };
      authService.setApi(mockApi);

      // Act & Assert
      await expect(authService.logout()).rejects.toThrow(
        'Logout failed. Please try again.',
      );
    });
  });
});
```

### Step 6: Use Builders and Fakes

Prefer in-memory fakes over deep mocking:

**Builder pattern**:

```typescript
// test/builders/user.builder.ts
export class UserBuilder {
  private user: User = {
    id: 'test-id',
    name: 'Test User',
    email: 'test@example.com',
  };

  withId(id: string): this {
    this.user.id = id;
    return this;
  }

  withEmail(email: string): this {
    this.user.email = email;
    return this;
  }

  build(): User {
    return { ...this.user };
  }
}

// In tests
const user = new UserBuilder().withEmail('custom@example.com').build();
```

**Fake implementation**:

```typescript
// test/fakes/fake-auth-api.ts
export class FakeAuthApi implements AuthApi {
  private shouldFail = false;

  async logout(): Promise<void> {
    if (this.shouldFail) {
      throw new Error('Network error');
    }
    // Success - no-op for fake
  }

  setFailure(shouldFail: boolean): void {
    this.shouldFail = shouldFail;
  }
}

// In tests
const fakeApi = new FakeAuthApi();
const authService = new AuthService(fakeApi);
```

### Step 7: Control External Boundaries

Make tests deterministic by controlling:

**Time**:

```typescript
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-02T12:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});
```

**Randomness**:

```typescript
const mockRandom = jest.spyOn(Math, 'random').mockReturnValue(0.5);
```

**Network**:

```typescript
// Use fakes or mock API responses
const mockFetch = jest.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ success: true }),
});
global.fetch = mockFetch;
```

### Step 8: Run Tests

```bash
# Run tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- auth-service.test.ts
```

Verify:

- All tests passing
- Coverage meets project standards (typically 80%+)
- No flaky tests (run multiple times to confirm)

### Step 9: Update Spec with Test Coverage

Add test coverage mapping to spec:

```markdown
## Test Coverage

| Acceptance Criterion     | Test File                 | Status     |
| ------------------------ | ------------------------- | ---------- |
| AC1.1: Clear token       | `auth-service.test.ts:12` | ✅ Passing |
| AC1.2: Redirect to login | `auth-router.test.ts:24`  | ✅ Passing |
| AC1.3: Show confirmation | `user-menu.test.ts:35`    | ✅ Passing |
| AC2.1: Show error        | `auth-service.test.ts:28` | ✅ Passing |

**Coverage**: 12 tests, 100% of acceptance criteria covered
```

## Testing Guidelines

### Unit Test Guidelines

Test individual units in isolation:

```typescript
// Good - Unit test for AuthService
it('should clear token on logout', () => {
  const authService = new AuthService(fakeApi);
  authService.logout();
  expect(authService.getToken()).toBeNull();
});

// Bad - Integration test disguised as unit test
it('should clear token on logout', () => {
  const authService = new AuthService(); // Uses real API
  authService.logout(); // Makes real network call
  expect(authService.getToken()).toBeNull(); // Flaky!
});
```

### Integration Test Guidelines

Test interactions between units:

```typescript
// Integration test for full logout flow
it('should complete full logout flow', async () => {
  // Arrange - Real dependencies
  const api = new AuthApi(testConfig);
  const authService = new AuthService(api);
  const router = new Router();

  // Act
  await authService.logout();

  // Assert
  expect(router.currentRoute).toBe('/login');
  expect(authService.isAuthenticated()).toBe(false);
});
```

### Edge Case Testing

Cover edge cases from spec:

```typescript
describe('edge cases', () => {
  it('should handle logout when already logged out', () => {
    // Arrange
    const authService = new AuthService();
    // User not logged in

    // Act & Assert - Should not throw
    expect(() => authService.logout()).not.toThrow();
  });

  it('should handle concurrent logout calls', async () => {
    // Arrange
    const authService = new AuthService();

    // Act - Multiple simultaneous logouts
    await Promise.all([
      authService.logout(),
      authService.logout(),
      authService.logout(),
    ]);

    // Assert - Only one API call made
    expect(mockApi.post).toHaveBeenCalledTimes(1);
  });
});
```

### Error Path Testing

Test all error conditions:

```typescript
describe('error handling', () => {
  it('should handle 401 unauthorized error', async () => {
    // Arrange
    mockApi.post.mockRejectedValue({ status: 401 });

    // Act & Assert
    await expect(authService.logout()).rejects.toThrow('Unauthorized');
  });

  it('should handle timeout error', async () => {
    // Arrange
    mockApi.post.mockRejectedValue({ code: 'ETIMEDOUT' });

    // Act & Assert
    await expect(authService.logout()).rejects.toThrow('Request timeout');
  });
});
```

## Parallel Execution with Implementation

Tests can be written in parallel with implementation.

### Approach: TDD-Style

1. Write tests first (they will fail)
2. Run implementer in parallel
3. Tests pass as implementation completes

```javascript
// Main agent dispatches both
Task({
  description: 'Write tests for logout',
  prompt: 'Write tests for all ACs in logout-button spec...',
  subagent_type: 'test-writer',
});

Task({
  description: 'Implement logout',
  prompt: 'Implement logout functionality per spec...',
  subagent_type: 'implementer',
});
```

### Synchronization Point

After both complete:

- Run tests to verify implementation
- Use `/unify` to validate alignment

## Test Anti-Patterns to Avoid

### Don't Test Implementation Details

```typescript
// Bad - Tests implementation
it('should call localStorage.removeItem', () => {
  authService.logout();
  expect(localStorage.removeItem).toHaveBeenCalledWith('auth_token');
});

// Good - Tests behavior
it('should clear token on logout', () => {
  authService.logout();
  expect(authService.getToken()).toBeNull();
});
```

### Don't Use Deep Mocking

```typescript
// Bad - Deep mock
jest.mock('./auth-service', () => ({
  AuthService: jest.fn().mockImplementation(() => ({
    logout: jest.fn(),
    getToken: jest.fn(),
  })),
}));

// Good - Fake implementation
class FakeAuthService implements AuthService {
  logout() {
    /* simple fake behavior */
  }
  getToken() {
    return null;
  }
}
```

### Don't Write Brittle Tests

```typescript
// Bad - Brittle (breaks if message changes)
expect(error.message).toBe('Logout failed. Please try again.');

// Good - Flexible (tests intent)
expect(error.message).toMatch(/logout failed/i);
```

## Integration with Other Skills

After writing tests:

- Use `/implement` (if not run in parallel) to implement features
- Use `/unify` to validate spec-test-implementation alignment
- Tests become evidence in convergence validation

## Examples

### Example 1: Unit Test for AuthService

**Spec AC1.1**: Logout button clears authentication token

**Test**:

```typescript
// src/services/__tests__/auth-service.test.ts
import { AuthService } from '../auth-service';
import { FakeAuthApi } from '../../test/fakes/fake-auth-api';

describe('AuthService', () => {
  describe('logout (AC1.1)', () => {
    it('should clear authentication token', async () => {
      // Arrange
      const fakeApi = new FakeAuthApi();
      const authService = new AuthService(fakeApi);
      authService.setToken('test-token-123');

      // Act
      await authService.logout();

      // Assert
      expect(authService.getToken()).toBeNull();
    });
  });
});
```

### Example 2: Integration Test for Logout Flow

**Spec AC1.2**: User is redirected to login page after logout

**Test**:

```typescript
// tests/integration/logout-flow.test.ts
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { App } from "../../src/App";

describe("Logout flow integration (AC1.2)", () => {
  it("should redirect to login page after logout", async () => {
    // Arrange
    render(<App initialRoute="/dashboard" />);
    const logoutButton = screen.getByRole("button", { name: /logout/i });

    // Act
    fireEvent.click(logoutButton);

    // Assert
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /login/i })).toBeInTheDocument();
    });
  });
});
```

### Example 3: Error Path Test

**Spec AC2.1**: Network error shows error message

**Test**:

```typescript
describe('error handling (AC2.1)', () => {
  it('should display error message on network failure', async () => {
    // Arrange
    const fakeApi = new FakeAuthApi();
    fakeApi.setFailure(true); // Simulate network error
    const authService = new AuthService(fakeApi);

    // Act
    const result = await authService.logout();

    // Assert
    expect(result.error).toBe(true);
    expect(result.message).toMatch(/logout failed/i);
  });
});
```
