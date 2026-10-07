---
"@vibeflow-tools/cli": patch
---

fix(cli): stop the test suite from leaking telemetry to production PostHog

The CLI test suite ran with telemetry enabled by default: `isTelemetryEnabled()`
only opted out via `VIBEFLOW_TELEMETRY=0`, and only 8 of ~150 test files set it.
E2E tests that spawn the CLI with a temp `HOME` minted a fresh `randomUUID()`
anonymous id per run (no `~/.vibeflow/config.json` to reuse), so every test run
fabricated new PostHog "users" — test traffic dominated the production user
count with throwaway anonymous ids.

Two layers now prevent the leak:

- A shared vitest setup file (`tests/setup/disable-telemetry.ts`) sets
  `VIBEFLOW_TELEMETRY=0` and is registered via `setupFiles` in all four CLI
  vitest configs (unit, integration, e2e, playwright). Spawned CLI subprocesses
  inherit it through `process.env`.
- `isTelemetryEnabled()` additionally refuses to enable under a test
  environment (`VITEST` set or `NODE_ENV=test`), so a future test file cannot
  leak by omission. Tests that must exercise the enabled-by-default path opt
  back in with `VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS=1`.

A regression test asserts telemetry cannot emit under vitest even with no
opt-out env set: no client is created, no anonymous id is minted, and no
`~/.vibeflow/config.json` is written.
