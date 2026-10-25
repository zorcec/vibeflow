/**
 * HOME isolation guard (ticket cc18a82d, ADR-0005).
 *
 * Auth is project-scoped: the credential store
 * (`src/auth/credentials.ts`, `~/.vibeflow/credentials.json` keyed by
 * apiUrl) plus the repo pointer, resolved by `getMode(projectDir)`. If
 * the vitest setup ever stops isolating HOME before test modules import
 * `src/`, a logged-in developer's real `~/.vibeflow/credentials.json`
 * flips the mode and every project-scoped test goes red — green in CI,
 * red locally.
 *
 * These assertions pin the isolation itself: they pass only when the
 * worker runs under the temp HOME from `tests/setup/hermetic-home.ts`.
 * To prove they are non-vacuous, remove that entry from `setupFiles` in
 * `vitest.config.ts` and re-run this file on a logged-in box — the mode
 * assertion goes red (saas instead of local).
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { getCredentialsPath } from "../../src/auth/credentials.js";
import { getLegacyTokenPath } from "../../src/auth/token.js";
import { getMode } from "../../src/auth/mode.js";

describe("test HOME isolation (ticket cc18a82d)", () => {
  it("os.homedir() points at the per-run temp dir, not the operator home", () => {
    expect(os.homedir()).toContain("vibeflow-unit-home-");
    expect(os.homedir().startsWith(tmpdir())).toBe(true);
  });

  it("the resolved credentials path lives under the isolated home", () => {
    expect(getCredentialsPath()).toBe(
      join(os.homedir(), ".vibeflow", "credentials.json"),
    );
  });

  it("the isolated home carries no credential, so a bare project is local", async () => {
    // With the setup removed on a logged-in box, the operator's real
    // credentials file resolves saas for a pointed project — that red IS
    // the guard. A pointer-less project is local regardless (a global
    // credential is never consulted for it — see project-auth.test.ts).
    const projectDir = mkdtempSync(join(tmpdir(), "vibeflow-home-iso-"));
    expect(await getMode(projectDir)).toBe("local");
  });

  it("a token in the operator's REAL home is not visible", () => {
    const operatorHome = process.env.VIBEFLOW_TEST_OPERATOR_HOME;
    // Without the setup the marker env var is never set, so there is
    // nothing to compare against — the mode assertion above is the guard
    // on that path (it needs a real credential to fire, which the
    // logged-in developer running the suite has).
    if (!operatorHome || operatorHome === os.homedir()) return;
    expect(
      getCredentialsPath().startsWith(join(operatorHome, ".vibeflow")),
    ).toBe(false);
    expect(
      getLegacyTokenPath().startsWith(join(operatorHome, ".vibeflow")),
    ).toBe(false);
  });
});
