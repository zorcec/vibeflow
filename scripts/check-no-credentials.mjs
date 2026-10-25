#!/usr/bin/env node
/**
 * Credential guard (ADR-0005).
 *
 * Project-scoped auth keeps secrets in `~/.vibeflow/credentials.json`
 * (user-scoped, keyed by apiUrl) and out of the repo entirely. This
 * fast (~100ms), dependency-free check fails the commit when a
 * credential store path is staged:
 * - any `credentials.json` (the user-scoped store, anywhere — HOME or a
 *   copied fixture), or
 * - any `.vibeflow/token` (the retired machine-global token).
 *
 * Secret *content* is gitleaks' job (it runs right after this in the
 * hook); this guard is the path backstop so a store file can never ride
 * along even when its bytes dodge every pattern.
 */
import { execFileSync } from "node:child_process";

const BLOCKED = [
  /(^|\/)credentials\.json$/,
  /(^|\/)\.vibeflow\/token$/,
];

function stagedPaths() {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split("\0").filter((p) => p.length > 0);
  } catch {
    return [];
  }
}

const hits = stagedPaths().filter((p) => BLOCKED.some((re) => re.test(p)));
if (hits.length > 0) {
  console.error(
    "✗ Credential guard: refusing to commit credential store files " +
      "(ADR-0005 — secrets live in ~/.vibeflow/, never the repo):",
  );
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log("✓ Credential guard passed.");
