/**
 * HOME isolation guard (ticket cc18a82d).
 *
 * The CLI captures its token path at module-load time
 * (`src/auth/token.ts`: `TOKEN_PATH` from `os.homedir()` on import), and
 * `getMode()` is `token present ? "saas" : "local"`. If the vitest setup
 * ever stops isolating HOME before test modules import `src/`, a
 * logged-in developer's real `~/.vibeflow/token` flips the mode and ten
 * mode-dependent tests (quarantine warnings, verify-reason handling,
 * command_run telemetry) fail — green in CI, red locally.
 *
 * These assertions pin the isolation itself: they pass only when the
 * worker runs under the temp HOME from `tests/setup/hermetic-home.ts`.
 * To prove they are non-vacuous, remove that entry from `setupFiles` in
 * `vitest.config.ts` and re-run this file on a logged-in box — the
 * mode assertion goes red (saas instead of local).
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTokenPath } from "../../src/auth/token.js";
import { getMode } from "../../src/auth/mode.js";

describe("test HOME isolation (ticket cc18a82d)", () => {
  it("os.homedir() points at the per-run temp dir, not the operator home", () => {
    expect(os.homedir()).toContain("vibeflow-unit-home-");
    expect(os.homedir().startsWith(tmpdir())).toBe(true);
  });

  it("the resolved token path lives under the isolated home", () => {
    expect(getTokenPath()).toBe(join(os.homedir(), ".vibeflow", "token"));
  });

  it("the isolated home carries no token, so the mode is local", async () => {
    // With the setup removed on a logged-in box, readToken() sees the
    // operator's real token and this returns "saas" — that red IS the guard.
    expect(await getMode()).toBe("local");
  });

  it("a token in the operator's REAL home is not visible", () => {
    const operatorHome = process.env.VIBEFLOW_TEST_OPERATOR_HOME;
    // Without the setup the marker env var is never set, so there is
    // nothing to compare against — the mode assertion above is the guard
    // on that path (it needs a real token to fire, which the logged-in
    // developer running the suite has).
    if (!operatorHome || operatorHome === os.homedir()) return;
    expect(getTokenPath().startsWith(join(operatorHome, ".vibeflow"))).toBe(
      false,
    );
  });
});
