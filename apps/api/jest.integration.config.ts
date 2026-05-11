import type { Config } from 'jest'

import baseConfig from './jest.config'

const config: Config = {
  ...baseConfig,
  testRegex: '\\.integration\\.spec\\.ts$',
  globalSetup: '<rootDir>/test/integration/global-setup.ts',
  globalTeardown: '<rootDir>/test/integration/global-teardown.ts',
}

export default config
