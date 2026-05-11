/* eslint-env node */
module.exports = {
  root: true,
  extends: ['@cc/eslint-config/react'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: ['node_modules', 'dist', 'coverage', '.turbo', 'vite.config.ts', 'postcss.config.js', 'tailwind.config.ts'],
}
