/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: [
    '@stryker-mutator/vitest-runner',
    '@stryker-mutator/typescript-checker',
  ],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.stryker.json',
  vitest: {
    configFile: 'vitest.config.ts',
  },
  // Scope to core logic only — exclude server, client bundles, CLI entry
  mutate: [
    'src/core/**/*.ts',
    'src/auth/**/*.ts',
    'src/commands/**/*.ts',
    'src/saas/**/*.ts',
  ],
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  thresholds: { high: 80, low: 60, break: null },
  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
}
