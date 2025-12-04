# @configs/eslint-config

Shared ESLint flat config for TypeScript/React projects in this monorepo. Bundles import sorting, TSDoc checks, Prettier alignment, and strictness rules used across apps and packages.

## Usage

1. Add the workspace dependency in `package.json`: `"@configs/eslint-config": "*"` (already wired for local packages).
2. Ensure peer deps are installed in the consumer workspace: `eslint`, `prettier`, `typescript`, and `jiti`.
3. Create or update `eslint.config.ts` in the consumer:

```ts
import { baseConfig, testConfig } from '@configs/eslint-config';

export default [
  ...baseConfig(__dirname, ['tsconfig.json']),
  // Optional: relaxed limits for tests
  // ...testConfig(__dirname, ['tsconfig.vitest.json'], ['src/**/*.test.ts']),
];
```

- `baseConfig(tsconfigRootDir, projectOverride?, files?)` returns the core config array.
- `testConfig(...)` layers relaxed max-lines thresholds for test files.
- Ignore patterns include `dist/`, `.next/`, `coverage/`, config files, and Markdown (`*.md`).

Run ESLint from the repo root with the workspace flag, e.g. `npm -w client-website run lint` or `npx eslint src --config eslint.config.ts`.
