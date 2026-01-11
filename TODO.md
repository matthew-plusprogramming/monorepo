# Dependency Update Verification Checklist

This checklist documents all tests and checks that should be run after updating dependencies to verify nothing is broken.

## 1. Install Dependencies

- [ ] Run `npm install` to install the updated dependencies
- [ ] Verify no peer dependency warnings or errors
- [ ] Verify `package-lock.json` is updated correctly

## 2. Build Checks

- [ ] Run `npm run build` (turbo build across all packages)
- [ ] Verify all packages compile without errors:
  - [ ] `packages/configs/vite-config` (tsc)
  - [ ] `packages/configs/vitest-config` (tsc)
  - [ ] `packages/core/schemas` (tsc)
  - [ ] `packages/core/ui-components` (tsc)
  - [ ] `packages/core/backend-core` (tsc + tsc-alias)
  - [ ] `apps/admin-portal` (next build)
  - [ ] `apps/client-website` (next build)
  - [ ] `apps/node-server` (vite build)
  - [ ] `apps/analytics-lambda` (vite build)

## 3. Linting

- [ ] Run `npm run lint` (turbo lint across all packages)
- [ ] Verify ESLint passes for all apps and packages
- [ ] Verify Stylelint passes for Next.js apps (admin-portal, client-website)
- [ ] Run `npm run lint:fix` if there are auto-fixable issues

## 4. Type Checking

- [ ] TypeScript compilation succeeds (covered by build step)
- [ ] No new type errors introduced by dependency updates
- [ ] Check for any breaking type changes in:
  - [ ] `zod` (4.2.1 -> 4.3.5) - schema validation types
  - [ ] `@tanstack/react-query` (5.90.14 -> 5.90.16)
  - [ ] `typescript-eslint` (8.50.1 -> 8.52.0)
  - [ ] `@types/node` (25.0.3 -> 25.0.6)

## 5. Unit Tests

- [ ] Run `npm run test` (turbo test across all packages)
- [ ] Verify all test suites pass:
  - [ ] `apps/admin-portal` tests (vitest)
  - [ ] `apps/client-website` tests (vitest)
  - [ ] `apps/node-server` tests (vitest)
  - [ ] `packages/core/schemas` tests (vitest)

## 6. Code Quality Checks

- [ ] Run `node .claude/scripts/check-code-quality.mjs`
- [ ] Verify all custom checks pass:
  - [ ] Effect run promise checks
  - [ ] Effect promise checks
  - [ ] Environment schema usage
  - [ ] Resource names
  - [ ] Console usage
  - [ ] Test AAA comments
  - [ ] Arrow function codemod

## 7. Agent Finalization

- [ ] Run `npm run phase:check` (combined lint:fix + code quality + build + test)
- [ ] Run `npm run agent:finalize` for final verification

## 8. Manual Smoke Tests

### Admin Portal (Next.js)
- [ ] Run `npm run dev` in `apps/admin-portal`
- [ ] Verify app starts without errors
- [ ] Check for React hydration errors in console
- [ ] Verify framer-motion animations work correctly
- [ ] Test react-hook-form form submissions

### Client Website (Next.js)
- [ ] Run `npm run dev` in `apps/client-website`
- [ ] Verify app starts without errors
- [ ] Check for React hydration errors in console
- [ ] Verify framer-motion animations work correctly
- [ ] Test react-hook-form form submissions

### Node Server (Express/Hono)
- [ ] Run `npm run dev` in `apps/node-server`
- [ ] Verify server starts without errors
- [ ] Test heartbeat endpoint
- [ ] Verify DynamoDB connections (if configured)
- [ ] Check Effect library functionality

### Analytics Lambda
- [ ] Run `npm run dev` in `apps/analytics-lambda`
- [ ] Verify lambda handler can be invoked locally
- [ ] Check DynamoDB operations work correctly

## 9. AWS SDK Verification

The following AWS SDK packages were updated (3.958.0 -> 3.966.0):
- [ ] Verify DynamoDB client operations work
- [ ] Verify EventBridge client operations work
- [ ] Verify CloudWatch Logs client operations work
- [ ] Check for any breaking changes in SDK responses

## 10. CDK Verification

- [ ] Navigate to `cdk/platform-cdk`
- [ ] Run `npm run synth` or `cdk synth` to verify CDK synthesis
- [ ] Verify no CloudFormation template changes (unless expected)

## 11. Monorepo Scripts

- [ ] Run `npm run test:scripts` to verify utility scripts work
- [ ] Verify turbo caching works correctly

## Summary of Updated Packages

### Root
- turbo: 2.7.2 -> 2.7.3

### AWS SDK (multiple packages)
- @aws-sdk/client-dynamodb: 3.958.0 -> 3.966.0
- @aws-sdk/client-eventbridge: 3.958.0 -> 3.966.0
- @aws-sdk/client-cloudwatch-logs: 3.958.0 -> 3.966.0
- @aws-sdk/util-dynamodb: 3.958.0 -> 3.966.0

### React Ecosystem
- @tanstack/react-query: 5.90.14 -> 5.90.16
- framer-motion: 12.23.26 -> 12.25.0
- react-hook-form: 7.69.0 -> 7.70.0

### Build Tools
- vite: 7.3.0 -> 7.3.1
- sass: 1.97.1 -> 1.97.2

### TypeScript/ESLint
- @typescript-eslint/eslint-plugin: 8.50.1 -> 8.52.0
- @typescript-eslint/parser: 8.50.1 -> 8.52.0
- typescript-eslint: 8.50.1 -> 8.52.0
- @eslint/compat: 2.0.0 -> 2.0.1
- @stylistic/eslint-plugin: 5.6.1 -> 5.7.0

### Other
- zod: 4.2.1 -> 4.3.5
- effect: 3.19.13 -> 3.19.14
- globals: 16.5.0 -> 17.0.0
- @dotenvx/dotenvx: 1.51.2 -> 1.51.4
- supertest: 7.1.4 -> 7.2.2
- @types/node: 25.0.3 -> 25.0.6
