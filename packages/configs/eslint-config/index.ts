import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import prettierPlugin from 'eslint-plugin-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tsdoc from 'eslint-plugin-tsdoc';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint, { type ConfigWithExtends } from 'typescript-eslint';
import { globalIgnores } from 'eslint/config';
import { includeIgnoreFile } from '@eslint/compat';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const eslintIgnorePatterns = [
  '**/.git',
  '**/node_modules',
  '**/dist',
  '**/build',
  '**/coverage',
  '**/out',
  '**/package.json',
  '**/package-lock.json',
  '**/*.config.ts',
  '*.md',
];

const gitignorePath = fileURLToPath(
  new URL('../../../.gitignore', import.meta.url),
);

export const baseConfig = (
  tsconfigDirectory: string,
  projectOverride?: string[],
): Array<ConfigWithExtends> => [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: projectOverride ?? ['tsconfig.json'],
        tsconfigRootDir: tsconfigDirectory,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslint,
      import: importPlugin,
      'simple-import-sort': simpleImportSort,
      'unused-imports': unusedImports,
      tsdoc: tsdoc as ESLint.Plugin,
      prettier: prettierPlugin,
      '@stylistic': stylistic,
    },
    rules: {
      // General TS best practices
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'warn',

      // Clean code
      'no-console': ['warn', { allow: ['info', 'warn', 'error'] }],
      'prefer-const': 'warn',
      'no-debugger': 'warn',

      // Prettier integration
      'prettier/prettier': 'warn',

      // Import sorting and organization
      'unused-imports/no-unused-imports': 'warn',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
      'simple-import-sort/imports': [
        'warn',
        {
          groups: [
            // Node.js builtins (fs, path)
            ['^node:'],
            ['^\\u0000'], // Side effect imports (e.g. import './global.css')
            ['^react$', '^react-dom$'], // React first (optional)
            ['^@?\\w'], // External packages
            ['^(@|components|utils|lib|services)(/.*|$)'], // Internal aliases
            ['^\\.\\.(?!/?$)', '^\\.\\./?$'], // Parent imports
            ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'], // Sibling & index
            ['^.+\\.?(css)$'], // Style imports
          ],
        },
      ],
      'simple-import-sort/exports': 'warn',

      // TSDoc
      'tsdoc/syntax': 'warn',

      // Personal preferences
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-inferrable-types': [
        'error',
        { ignoreParameters: false },
      ],
      '@typescript-eslint/no-use-before-define': [
        'error',
        { functions: false, classes: false },
      ],
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        { accessibility: 'explicit' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-irregular-whitespace': 'error',
      '@stylistic/js/arrow-parens': ['error', 'always'],
      '@stylistic/js/linebreak-style': ['error', 'unix'],
      '@stylistic/js/new-parens': 'error',
      '@stylistic/ts/no-extra-semi': 'error',
      '@stylistic/ts/space-before-blocks': 'error',
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: 'tsconfig.json',
        },
      },
    },
  },
  prettier,
  includeIgnoreFile(gitignorePath),
  globalIgnores(eslintIgnorePatterns),
];
