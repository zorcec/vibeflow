/**
 * Hermetic HOME for the e2e suite (bug 072d6a8a).
 *
 * The CLI merges the owner-global `~/.vibeflow/settings.json` into EVERY
 * project via `loadSettings()` — including the throwaway temp task stores
 * these tests create with `mkdtemp`. Tests that boot the server in-process
 * (`bootMcpServer`) read the worker's own `HOME`, so on a box whose owner
 * has e.g. `{"autoCommit": true}` globally, review gates demand a commit
 * message the tests never send and the suite fails for reasons that have
 * nothing to do with the change under test.
 *
 * Spawned-CLI tests already isolate per-run (`runCli`/`spawnApiServer` take
 * an explicit `home`); this covers the in-process half. Pointing the whole
 * worker at an empty temp HOME makes the suite independent of whoever runs
 * it. `os.homedir()` follows `$HOME` at call time on POSIX, and setup files
 * run before any test module imports `src/`, so module-load-time captures
 * (`src/auth/token.ts`, `src/auth/workspace.ts`) pick the isolated dir up.
 *
 * Product behaviour is untouched: `loadSettings()` still merges global
 * settings for real projects. Owner-global settings SHOULD govern real
 * projects — they just must not govern a scratch store.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Capture BEFORE overriding: two verify-* e2e files launch a real chromium
// in-process, and Playwright resolves its browsers under ~/.cache by
// default — an empty temp HOME would hide the installed browsers. Point
// Playwright at the operator's real browser cache (read-only use); the
// .vibeflow settings leak this file exists to fix stays fully isolated.
const realHome = process.env.HOME;
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && realHome) {
  const browsersPath = join(realHome, ".cache", "ms-playwright");
  if (existsSync(browsersPath)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  }
}

const cleanHome = mkdtempSync(join(tmpdir(), "vibeflow-e2e-home-"));
process.env.HOME = cleanHome;
