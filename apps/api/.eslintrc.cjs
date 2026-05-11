/* eslint-env node */
module.exports = {
  root: true,
  extends: ['@cc/eslint-config/node'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: ['dist', 'node_modules', 'coverage', '.turbo', 'prisma/migrations'],
}
