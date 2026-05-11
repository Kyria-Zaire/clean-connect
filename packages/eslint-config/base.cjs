/* eslint-env node */

/**
 * Config ESLint de base — TypeScript strict aligné avec tsconfig.base.json.
 * Étendre via :  extends: ['@cc/eslint-config/base']
 */
module.exports = {
  root: false,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'prettier',
  ],
  rules: {
    'no-console': ['error', { allow: ['error', 'warn'] }],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
    'import/order': [
      'warn',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    'import/no-default-export': 'off',
    eqeqeq: ['error', 'always'],
    curly: ['error', 'multi-line'],
  },
  ignorePatterns: ['dist', 'build', '.turbo', 'node_modules', 'coverage', '*.config.*'],
}
