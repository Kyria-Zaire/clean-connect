/* eslint-env node */

module.exports = {
  extends: ['./base.cjs'],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    'no-console': ['error', { allow: ['error', 'warn'] }],
  },
}
