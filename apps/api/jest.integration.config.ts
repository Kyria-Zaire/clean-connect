import type { Config } from 'jest'

import baseConfig from './jest.config'

const config: Config = {
  ...baseConfig,
  setupFiles: ['<rootDir>/test/integration/jest-env.setup.ts'],
  testRegex: '\\.integration\\.spec\\.ts$',
  /** Ne pas hériter de l'exclusion `\\.integration\\.spec\\.ts$` du jest unitaire. */
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 120_000,
  globalSetup: '<rootDir>/test/integration/global-setup.ts',
  globalTeardown: '<rootDir>/test/integration/global-teardown.ts',
}

export default config
