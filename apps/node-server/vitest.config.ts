import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { nodeConfig } from '@configs/vitest-config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const baseConfig = nodeConfig({
  projectRoot: __dirname,
});

const baseTest = baseConfig.test ?? {};
const defaultInclude = baseTest.include ?? ['src/**/*.test.ts'];
const defaultCoverage = baseTest.coverage;
const defaultEnvironment = baseTest.environment ?? 'node';
const integrationGlob = 'src/__tests__/integration/**/*.test.ts';

baseConfig.test = {
  ...baseTest,
  projects: [
    {
      extends: true,
      ...baseTest,
      name: 'node-server',
      environment: defaultEnvironment,
      include: defaultInclude,
      exclude: [integrationGlob],
      coverage: defaultCoverage,
    },
    {
      extends: true,
      ...baseTest,
      name: 'node-server-integration',
      environment: defaultEnvironment,
      include: [integrationGlob],
      maxWorkers: 1,
      coverage: false,
    },
  ],
};

export default defineConfig(baseConfig);
