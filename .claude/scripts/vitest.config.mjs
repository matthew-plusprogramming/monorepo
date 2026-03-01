import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: resolve(__dirname, '__tests__'),
    environment: 'node',
    include: ['**/*.test.{mjs,js}'],
    globals: false,
  },
});
