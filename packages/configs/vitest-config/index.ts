import { resolve } from 'node:path';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

export interface SharedVitestConfigOptions {
  projectRoot: string;
  srcDir?: string;
  include?: string[];
  alias?: Record<string, string>;
}

const defaultInclude = ['src/**/*.test.ts'];

const createBaseConfig = (
  options: SharedVitestConfigOptions,
): ViteUserConfig => {
  const {
    projectRoot,
    srcDir = 'src',
    include = defaultInclude,
    alias,
  } = options;

  const coverageInclude = [
    `${srcDir}/**/*.ts`,
    `${srcDir}/**/*.tsx`,
    `${srcDir}/**/*.mts`,
  ];

  const coverageExclude = [
    ...include,
    `${srcDir}/**/__tests__/**/*`,
    `${srcDir}/**/__mocks__/**/*`,
    `${srcDir}/**/*.test.*`,
    `${srcDir}/**/*.spec.*`,
    `${srcDir}/**/*.d.ts`,
  ];

  return {
    resolve: {
      alias: {
        '@': resolve(projectRoot, srcDir),
        ...alias,
      },
    },
    test: {
      include,
      coverage: {
        include: coverageInclude,
        exclude: coverageExclude,
      },
    },
  } satisfies ViteUserConfig;
};

export const nodeConfig = (
  options: SharedVitestConfigOptions,
): ViteUserConfig => {
  const base = createBaseConfig(options);
  const baseTest = base.test ?? {};

  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      environment: 'node',
    },
  });
};

export const browserConfig = (
  options: SharedVitestConfigOptions,
): ViteUserConfig => {
  const base = createBaseConfig(options);
  const baseTest = base.test ?? {};

  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      environment: 'jsdom',
    },
  });
};
