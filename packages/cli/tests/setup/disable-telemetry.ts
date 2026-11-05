/**
 * Shared vitest setup — telemetry must never fire from the test suite.
 *
 * Registered via `setupFiles` in all four CLI vitest configs (unit,
 * integration, e2e, playwright). Tests that spawn the CLI with a temp `HOME`
 * would otherwise mint a fresh `randomUUID()` anonymous id per run and ship it
 * to the production PostHog project — one OS username fingerprint produced 444
 * of 454 production "users".
 *
 * Env set here propagates to spawned CLI subprocesses through the usual
 * `process.env` inheritance, which is what actually stops the e2e leak.
 * `src/telemetry.ts` additionally refuses to enable under vitest / NODE_ENV=test
 * as a second layer, so a test file cannot leak by omission even if this
 * registration is ever dropped.
 */
process.env.VIBEFLOW_TELEMETRY = "0";
/**
 * Hooks off by default under test (Stage 1, ADR-0006): hook emission
 * spawns child processes and materialises shipped defaults into HOME,
 * which would make every operation test slow and non-hermetic. Hook
 * unit tests opt back in per case (explicit `env` without the kill
 * switch); the e2e hook spec spawns the CLI with its own env likewise.
 */
if (!process.env.VIBEFLOW_HOOKS) {
  process.env.VIBEFLOW_HOOKS = "0";
}
