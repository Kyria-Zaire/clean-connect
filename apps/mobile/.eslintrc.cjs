/* eslint-env node */
module.exports = {
  root: true,
  extends: ['@cc/eslint-config/react'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    // react-native ships du Flow → eslint-plugin-import ne sait pas le parser.
    // Le typecheck TS suffit pour valider les imports natifs.
    'import/namespace': 'off',
  },
  ignorePatterns: [
    'node_modules',
    '.expo',
    'dist',
    'coverage',
    '.turbo',
    'babel.config.js',
    'metro.config.js',
    'tailwind.config.js',
  ],
}
