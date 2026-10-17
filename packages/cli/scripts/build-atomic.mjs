#!/usr/bin/env node
/**
 * Atomic CLI build: stage the full dist tree in `dist.next/`, then sync it
 * into the live `dist/` without ever deleting `dist/` itself.
 *
 * WHAT: every build step (the six prebuild generators + both tsup bundles)
 * writes into a staging dir on the same filesystem, and the final step
 * copies each staged file over its live counterpart via temp-file + rename
 * (entry files last), deleting stale live files only AFTER the new tree is
 * complete.
 *
 * WHY: `prebuild` used to start with `rm -rf dist`, so every build deleted
 * the live tree before rebuilding it. Any e2e run that shelled out to
 * `node packages/cli/dist/cli/index.js` mid-build found dist missing or
 * half-written (worse: chunk filenames are content-hashed and change per
 * build, so a fresh index.js could reference chunks the `rm` had already
 * deleted) and failed spuriously — observed as mcp-stdio, mcp-cli-parity
 * and every tasks-* e2e failing together, then passing when no build ran.
 *
 * WHO/WHEN: agent decision, 2026-10-17, ticket 328b5420. A single rename(2)
 * of the whole directory is NOT possible (POSIX rename cannot replace a
 * non-empty directory, and turning dist/ into a swapped symlink would
 * change realpath/__dirname behaviour for the pre-push hook, e2e, and the
 * kanban/MCP servers that consume dist/ paths) — so per-file temp+rename
 * with entries-last ordering is the atomicity mechanism. Readers may briefly
 * see a mix of old+new files during the sync, but never a missing file and
 * never a half-written one, and either generation is self-consistent
 * (stale files are deleted last, so both the old and the new chunk sets
 * resolve while the sync runs).
 *
 * IMPACT: measured zero `test -f dist/cli/index.js` misses during a build
 * after this change (before: the file was absent from `rm -rf` until the
 * CLI bundle finished, plus a mixed-chunk window until onSuccess synced).
 * A failed build now leaves the previous good dist/ untouched instead of
 * an empty directory.
 */
import { execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const monorepoRoot = resolve(cliRoot, "..", "..");
const LIVE_NAME = "dist";
const STAGING_NAME = "dist.next";
const liveDir = resolve(cliRoot, LIVE_NAME);
const stagingDir = resolve(cliRoot, STAGING_NAME);

const tsupBin = [cliRoot, monorepoRoot]
  .map((r) => resolve(r, "node_modules", ".bin", "tsup"))
  .find((p) => existsSync(p));
if (!tsupBin) {
  throw new Error(
    "[build-atomic] tsup binary not found under cli or monorepo node_modules/.bin — run pnpm install",
  );
}

function sh(cmd, env = process.env) {
  execSync(cmd, { cwd: cliRoot, env, stdio: "inherit" });
}

/** Relative POSIX-style paths of every file under dir. */
function walkFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walkFiles(abs, base, out);
    else out.push(abs.slice(base.length + 1));
  }
  return out;
}

/**
 * Sync the staged tree into the live tree. Every file lands via
 * temp-copy + rename (atomic on the same filesystem), entry files last so
 * no live index.js ever references chunks that are not on disk yet, and
 * stale live files are deleted only after the new tree is complete — so
 * the live dir is never absent, never half-written, and always resolves.
 */
function syncStagingToLive() {
  mkdirSync(liveDir, { recursive: true });
  const staged = walkFiles(stagingDir);
  const stagedSet = new Set(staged);
  // Entries last: they reference the hashed chunks, which must be in place.
  const isEntry = (rel) =>
    rel === "index.js" ||
    rel === join("cli", "index.js") ||
    rel === "index.d.ts" ||
    rel === join("cli", "index.d.ts");
  const ordered = [
    ...staged.filter((r) => !isEntry(r)),
    ...staged.filter((r) => isEntry(r)),
  ];
  for (const rel of ordered) {
    const src = join(stagingDir, rel);
    const dest = join(liveDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
  }
  // Stale cleanup LAST: files the new build no longer emits (e.g. old
  // content-hashed chunks) are removed only once nothing references them.
  // This is the `rm -rf dist` stale-file cleanup, done on the live tree
  // after the swap instead of before the build.
  const liveFiles = walkFiles(liveDir).filter(
    (rel) => !rel.endsWith(`.tmp-${process.pid}`),
  );
  for (const rel of liveFiles) {
    if (!stagedSet.has(rel)) rmSync(join(liveDir, rel));
  }
  // Drop live dirs left empty by the stale cleanup (deepest first), but
  // never the live root itself. Staging dirs are recreated by mkdir above.
  const liveDirs = [];
  (function collect(dir) {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        collect(abs);
        liveDirs.push(abs);
      }
    }
  })(liveDir);
  for (const dir of liveDirs) {
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
    } catch {
      /* racing reader recreated it — leave it */
    }
  }
  try {
    chmodSync(join(liveDir, "index.js"), 0o755);
  } catch {
    /* first build races are reported by tsup itself */
  }
}

// Fresh staging dir on the SAME filesystem as dist/ (same parent dir), so
// every rename below is same-filesystem and atomic. Stale-file cleanup
// (`rm -rf`) happens HERE, on the staging dir — never on the live dist.
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(join(stagingDir, "client"), { recursive: true });

const stagingEnv = { ...process.env, VIBEFLOW_DIST_DIR: STAGING_NAME };

sh(`node ${resolve(cliRoot, "scripts", "gen-overlay-css.mjs")}`, stagingEnv);
sh(
  `node ${resolve(cliRoot, "scripts", "gen-overlay-bundle.mjs")}`,
  stagingEnv,
);
sh(`node ${resolve(cliRoot, "scripts", "gen-kanban-css.mjs")}`, stagingEnv);
sh(`node ${resolve(cliRoot, "scripts", "gen-codec-assets.mjs")}`, stagingEnv);
sh(`node ${resolve(cliRoot, "scripts", "embed-swagger-ui.mjs")}`, stagingEnv);
sh(
  `node ${resolve(monorepoRoot, "packages", "api-core", "scripts", "gen-api-artifacts.mjs")}`,
  stagingEnv,
);
sh(`"${tsupBin}"`, stagingEnv);
sh(`"${tsupBin}" --config tsup.cli.config.ts`, stagingEnv);

syncStagingToLive();
console.log(`[build-atomic] staged ${STAGING_NAME}/ → synced into ${LIVE_NAME}/`);

// The staging dir is a build artifact (gitignored). Keep it: a failed build
// must not delete the previous staging output before the failure is read.
if (!existsSync(join(liveDir, "cli", "index.js"))) {
  throw new Error(
    "[build-atomic] live dist/cli/index.js missing after sync — refusing to leave a broken dist",
  );
}
