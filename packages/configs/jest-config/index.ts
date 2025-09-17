import type { Config } from 'jest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const baseConfig = {
  preset: 'ts-jest',
  clearMocks: true,
  restoreMocks: true,
  resetModules: true,
  setupFilesAfterEnv: [`${__dirname}/jest.setup.ts`],
} satisfies Config;

export const nodeConfig = {
  ...baseConfig,
  testEnvironment: 'node',
};

export const browserConfig = {
  ...baseConfig,
  testEnvironment: 'jsdom',
};
