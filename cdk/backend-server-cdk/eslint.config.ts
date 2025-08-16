import { baseConfig } from '@configs/eslint-config';

export default [...baseConfig(__dirname, ['tsconfig.lint.json'])];
