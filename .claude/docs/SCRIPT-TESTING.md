# Script Testing Guide

This document describes how to write and run unit tests for scripts in `.claude/scripts/`.

---

## Overview

The scripts directory uses two complementary testing approaches:

| Approach              | Location                               | Runner         | Purpose                                                                                    |
| --------------------- | -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| **Unit tests**        | `.claude/scripts/__tests__/*.test.mjs` | vitest         | Test internal functions in isolation (pure logic, transformations, parsing)                |
| **Integration tests** | `.claude/scripts/test-hooks.mjs`       | Custom harness | Test end-to-end hook behavior (stdin parsing, pattern matching, exit codes, stdout/stderr) |

Unit tests are fast, focused, and run with `npm run test:scripts`. Integration tests spawn child processes and validate the full hook pipeline.

---

## Running Tests

```bash
# Run all script unit tests
npm run test:scripts

# Run tests in watch mode (re-runs on file change)
npm run test:scripts:watch

# Run a specific test file
npx vitest run --config .claude/scripts/vitest.config.mjs hook-wrapper

# Run integration tests (separate harness)
node .claude/scripts/test-hooks.mjs
```

---

## Vitest Configuration

The vitest configuration lives at `.claude/scripts/vitest.config.mjs`. It is isolated from any consumer project's vitest config by using the `--config` flag explicitly in npm scripts.

**Key settings**:

- **Root**: `.claude/scripts/__tests__/` -- vitest discovers test files from this directory
- **Environment**: `node` -- scripts use Node.js APIs (`fs`, `path`, `child_process`), not browser APIs
- **Include pattern**: `**/*.test.{mjs,js}` -- matches `.test.mjs` and `.test.js` files
- **Globals**: `false` -- import `describe`, `it`, `expect` explicitly from `vitest`

---

## Adding a New Test File

### 1. Create the test file

Place your test file in `.claude/scripts/__tests__/` with the naming convention `<script-name>.test.mjs`:

```bash
.claude/scripts/__tests__/
  hook-wrapper.test.mjs        # Tests for hook-wrapper.mjs
  my-validator.test.mjs        # Tests for my-validator.mjs
```

### 2. Import from vitest and the script under test

```javascript
import { describe, it, expect } from 'vitest';
import { myFunction } from '../my-script.mjs';
```

**Important**: The script under test must export the functions you want to test. If the script calls `main()` unconditionally, you must add a main() guard first (see "Making Scripts Testable" below).

### 3. Write tests using AAA convention

Follow the Arrange-Act-Assert pattern with comments:

```javascript
describe('myFunction', () => {
  it('should handle the expected input correctly', () => {
    // Arrange
    const input = 'test-value';

    // Act
    const result = myFunction(input);

    // Assert
    expect(result).toBe('expected-output');
  });
});
```

### 4. Run your tests

```bash
npm run test:scripts
```

---

## Making Scripts Testable

Many scripts in `.claude/scripts/` call `main()` unconditionally at the bottom of the file. When vitest imports such a script, `main()` executes as a side effect (reading stdin, calling `process.exit()`, etc.). To make a script's internal functions testable:

### Step 1: Add named exports

```javascript
// At the end of the script, export functions you want to test
export { myPureFunction, myOtherFunction };
```

### Step 2: Guard main() behind direct-run detection

Replace the unconditional `main()` call:

```javascript
// Before (untestable):
main();

// After (testable):
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;
if (isDirectRun) {
  main();
}
```

This ensures `main()` only runs when the script is invoked directly (e.g., by a hook), not when imported by vitest.

### Step 3: Verify CLI behavior is preserved

After adding exports and the main() guard, run the integration test harness to confirm no regression:

```bash
node .claude/scripts/test-hooks.mjs
```

---

## Fixture Files

Test fixture files live in `.claude/scripts/__fixtures__/` and are shared between unit tests and the integration test harness.

**Existing fixtures**:

| File                                                          | Purpose                          |
| ------------------------------------------------------------- | -------------------------------- |
| `valid.json` / `invalid.json`                                 | JSON validation testing          |
| `valid-agent.md` / `invalid-agent-missing-model.md`           | Agent frontmatter validation     |
| `valid-SKILL.md` / `invalid-SKILL-missing-fields.md`          | Skill frontmatter validation     |
| `valid-spec.md` / `invalid-spec-missing-sections.md`          | Spec structure validation        |
| `valid-manifest.json` / `invalid-manifest-missing-id.json`    | Manifest validation              |
| `manifest-bad-convergence.json`                               | Non-canonical convergence fields |
| `superseded-spec.md`                                          | Superseded artifact testing      |
| `valid-file.ts` / `invalid-file.ts`                           | TypeScript validation            |
| `valid-template.md`                                           | Template validation              |
| `valid-session.json` / `invalid-session-missing-history.json` | Session validation               |

**Using fixtures in tests**:

```javascript
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', '__fixtures__');

it('should parse a valid JSON fixture', () => {
  // Arrange
  const content = readFileSync(join(fixturesDir, 'valid.json'), 'utf-8');

  // Act
  const parsed = JSON.parse(content);

  // Assert
  expect(parsed).toBeDefined();
});
```

---

## Example: Testing hook-wrapper.mjs

The `hook-wrapper.mjs` script exports `globToRegex` and `matchesPattern` for unit testing. See `.claude/scripts/__tests__/hook-wrapper.test.mjs` for the full example:

```javascript
import { describe, it, expect } from 'vitest';
import { globToRegex, matchesPattern } from '../hook-wrapper.mjs';

describe('globToRegex', () => {
  it('should convert * wildcard to match any characters except /', () => {
    // Arrange
    const pattern = '*.json';

    // Act
    const result = globToRegex(pattern);

    // Assert
    expect(result).toBe('[^/]*\\.json');
  });
});

describe('matchesPattern', () => {
  it('should match a file path against a simple extension pattern', () => {
    // Arrange
    const filePath = 'src/config.json';
    const pattern = '*.json';

    // Act
    const result = matchesPattern(filePath, pattern);

    // Assert
    expect(result).toBe(true);
  });
});
```

---

## Consumer Projects

Consumer projects that sync from metaclaude-assistant receive the vitest config, test files, and fixtures via the sync system. To enable script testing in a consumer project:

### 1. Install vitest (if not already installed)

```bash
npm install --save-dev vitest
```

### 2. Add npm scripts to package.json

```json
{
  "scripts": {
    "test:scripts": "vitest run --config .claude/scripts/vitest.config.mjs",
    "test:scripts:watch": "vitest --config .claude/scripts/vitest.config.mjs"
  }
}
```

These npm scripts are not synced automatically -- they must be added manually to each consumer project's package.json.

---

## When to Use Unit Tests vs Integration Tests

| Scenario                         | Use Unit Tests | Use Integration Tests |
| -------------------------------- | -------------- | --------------------- |
| Testing a pure function (no I/O) | Yes            | No                    |
| Testing pattern matching logic   | Yes            | No                    |
| Testing stdin/stdout behavior    | No             | Yes                   |
| Testing exit codes               | No             | Yes                   |
| Testing process spawning         | No             | Yes                   |
| Testing file parsing logic       | Yes            | No                    |
| Testing end-to-end hook pipeline | No             | Yes                   |

**Rule of thumb**: If the function takes inputs and returns outputs without side effects, use a unit test. If the behavior involves stdin, stdout, exit codes, or child processes, use the integration test harness.
