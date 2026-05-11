/* eslint-env node */
module.exports = {
  root: true,
  extends: ['@cc/eslint-config/react'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: ['node_modules', '.expo', 'dist', 'coverage', '.turbo', 'babel.config.js', 'metro.config.js', 'tailwind.config.js'],
}
