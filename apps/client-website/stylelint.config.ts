export default {
  extends: [
    'stylelint-config-standard',
    'stylelint-config-standard-scss',
    'stylelint-config-clean-order',
  ],
  plugins: [],
  rules: {
    // General rules
    'no-empty-source': null,
    'color-hex-length': 'short',
    'color-function-notation': 'modern',
    'alpha-value-notation': 'number',

    // SCSS-specific rules
    'scss/load-no-partial-leading-underscore': true,
    'scss/dollar-variable-pattern': '^[_a-z]+[a-zA-Z0-9-]*$',
    'scss/at-rule-no-unknown': true,

    // Allow nesting
    'selector-nested-pattern': '^&',

    // Control selector naming
    'selector-class-pattern': '^[a-zA-Z0-9\\-_]+$',
  },
  ignoreFiles: ['**/node_modules/**', '**/dist/**', '**/build/**'],
};
