import { baseConfig } from '@configs/eslint-config';

export default [
  ...baseConfig(__dirname, ['tsconfig.lint.json']),
  {
    rules: {
      'require-yield': 'warn',
    },
  },
];
