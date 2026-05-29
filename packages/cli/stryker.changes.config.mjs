/**
 * Stryker config for changed-files-only runs.
 *
 * Same as stryker.config.mjs but disables `vitest.related` so stryker
 * doesn't try to resolve test files via import tracing. Instead it uses
 * perTest coverage analysis (always enabled) to run only the tests that
 * cover each mutant. This is required when mutating files that are only
 * tested through Playwright (no direct unit-test imports).
 *
 * Used automatically by `scripts/mutation.mjs` when changed source files
 * are detected. Never run directly.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
import baseConfig from './stryker.config.mjs';

export default {
  ...baseConfig,
  vitest: {
    ...baseConfig.vitest,
    related: false,
  },
};
