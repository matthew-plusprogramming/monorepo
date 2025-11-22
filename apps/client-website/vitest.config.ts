import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserConfig } from '@configs/vitest-config';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const baseConfig = browserConfig({
  projectRoot: __dirname,
  srcDir: 'src',
  include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  alias: {
    '@': resolve(__dirname, 'src'),
  },
});

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    setupFiles: ['src/test/setup.ts'],
  },
});
