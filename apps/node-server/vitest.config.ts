import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { nodeConfig } from '@configs/vitest-config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig(
  nodeConfig({
    projectRoot: __dirname,
  }),
);
