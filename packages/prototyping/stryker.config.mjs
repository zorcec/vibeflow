/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: {
    configFile: "vitest.config.ts",
  },
  mutate: ["src/**/*.ts", "src/**/*.tsx"],
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  thresholds: { high: 80, low: 60, break: null },
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
};
