import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import prettierPlugin from 'eslint-plugin-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tsdocPlugin from 'eslint-plugin-tsdoc';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint, { type ConfigWithExtends } from 'typescript-eslint';
import { globalIgnores } from 'eslint/config';
import { includeIgnoreFile } from '@eslint/compat';
import { fileURLToPath } from 'node:url';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';

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
      tsdoc: tsdocPlugin,
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
      'prefer-arrow-callback': ['error', { allowNamedFunctions: false }],
      'func-style': ['error', 'expression'],

      // Strictest rules
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: false },
      ],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/prefer-readonly': 'warn',
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],

      // Strict code structure
      complexity: ['warn', { max: 10 }],
      'max-lines': ['warn', 300],
      'max-lines-per-function': ['warn', 75],
      'max-depth': ['warn', 4],
      'max-nested-callbacks': ['warn', 3],

      // Strict clarity and whitespace
      '@stylistic/js/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/js/semi': ['error', 'always'],
      '@stylistic/js/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/js/indent': ['error', 2, { SwitchCase: 1 }],
      '@stylistic/js/space-infix-ops': 'error',

      // Deprecated rules
      '@typescript-eslint/no-deprecated': 'error',
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

export const reactConfig = (
  tsconfigDirectory: string,
  projectOverride?: string[],
): Array<ConfigWithExtends> => [
  ...baseConfig(tsconfigDirectory, projectOverride),
  {
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11yPlugin,
    },
    rules: {
      'react/jsx-boolean-value': ['error', 'never'],
      'react/jsx-no-useless-fragment': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'jsx-a11y/no-autofocus': 'warn',
    },
  },
];
