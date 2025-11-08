import { baseConfig, testConfig } from '@configs/eslint-config';

export default [
  ...baseConfig(__dirname, ['tsconfig.lint.json']),
  ...testConfig(__dirname, ['tsconfig.test.json'], ['src/__tests__/**/*.ts']),
];
