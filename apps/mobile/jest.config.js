/* eslint-env node */

/**
 * Tests unitaires mobile (logique pure TS).
 *
 * On limite volontairement le scope à `.spec.ts` (pas `.spec.tsx`) :
 * les composants React Native nécessitent un runtime complet (jest-expo)
 * et seront couverts par des tests E2E / detox en PRD ultérieur.
 *
 * Le transformer babel-jest est récupéré via `babel-preset-expo` configuré
 * dans `babel.config.js` (déjà aligné monorepo + TS).
 */

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testRegex: '\\.spec\\.ts$',
  testPathIgnorePatterns: [
    '/node_modules/',
    '/\\.expo/',
    '/dist/',
  ],
  transform: {
    '^.+\\.(ts|tsx|js|jsx)$': ['babel-jest', { configFile: './babel.config.js' }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
}
