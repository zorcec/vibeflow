/**
 * Global setup: hermetic HOME for threads-pool workers (ticket cc18a82d).
 *
 * WHY globalSetup and not setupFiles: vitest's `threads` pool runs tests
 * in `worker_threads`, where `os.homedir()` is FROZEN at worker-spawn time
 * — setting `process.env.HOME` later (even in a setup file) changes the
 * env var but not what `os.homedir()` returns (measured: setup sets
 * `HOME=/tmp/vibeflow-unit-home-XXX` yet `os.homedir()` still returns
 * `/root`; the `forks` pool follows `$HOME` normally). Workers snapshot
 * the main process env at creation, and creation happens after
 * globalSetup — so redirecting HOME here is the only point in the
 * lifecycle where the threads pool can be isolated. (The e2e/Playwright
 * configs already isolate via setupFiles, but those use the `forks` pool,
 * where the late redirect works.)
 *
 * The CLI captures its token path at module-load time
 * (`src/auth/token.ts`) and `getMode()` is `token present ? "saas" :
 * "local"`, so without this a logged-in developer's real
 * `~/.vibeflow/token` flips the mode and ten mode-dependent unit tests
 * fail — green in CI, red locally. The CLI honours HOME only (no
 * VIBEFLOW_HOME or XDG_* override in `src/`, verified by grep), so
 * redirecting HOME alone is sufficient.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default function hermeticHome(): void {
  // Capture BEFORE overriding: the guard test
  // (`tests/unit/home-isolation.test.ts`) uses it to prove the resolved
  // token path is NOT under the operator's real home. Never write to it.
  const realHome = process.env.HOME;
  if (realHome) {
    process.env.VIBEFLOW_TEST_OPERATOR_HOME = realHome;
    // Unit tests do not launch browsers, but keep the installed Playwright
    // browsers visible anyway (same as the e2e setup) so a future browser
    // import cannot fail for a missing cache.
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
      const browsersPath = join(realHome, ".cache", "ms-playwright");
      if (existsSync(browsersPath)) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
      }
    }
  }

  // One temp HOME per vitest invocation, shared by all workers in the run:
  // it only needs to be token-free (tests build their own fixture homes),
  // and a shared empty dir is exactly what the green `HOME=/tmp/emptyhome`
  // baseline run proved sufficient.
  process.env.HOME = mkdtempSync(join(tmpdir(), "vibeflow-unit-home-"));
}
