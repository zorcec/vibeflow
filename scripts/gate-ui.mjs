#!/usr/bin/env node
/**
 * Slow-lane design-system gate (P17).
 *
 * The fast lane (`.husky/pre-push`) runs unit + stories in ~20 s. The checks
 * that do not belong there — a Storybook build (minutes), the overlay pixel
 * guard (needs a built bundle), the story-matrix/a11y sweep across all six
 * themes, and the bundle budget — live here, in one command, failing fast.
 *
 * usage: node scripts/gate-ui.mjs [--only=budget|matrix|stories|storybook]
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const started = Date.now();

const steps = [
  {
    name: "bundle budget",
    cmd: ["node", "packages/cli/scripts/check-bundle-budget.mjs"],
    why: "cheap; also runs in the fast lane for cli/ui changes",
  },
  {
    name: "ui unit suite",
    cmd: ["pnpm", "--filter", "@vibeflow-tools/ui", "run", "test"],
    why: "includes the story-matrix discovery and the six-theme a11y sweep",
  },
  {
    name: "ui stories",
    cmd: ["pnpm", "--filter", "@vibeflow-tools/ui", "run", "test:stories"],
    why: "browser stories in chromium — jsdom cannot drive focus/portal behaviour",
  },
  {
    name: "ui coverage",
    cmd: ["pnpm", "--filter", "@vibeflow-tools/ui", "run", "coverage"],
    why: "design-system surface threshold, 100% variant branches",
  },
  {
    name: "storybook build",
    cmd: ["pnpm", "--filter", "@vibeflow-tools/ui", "run", "build-storybook"],
    why: "the static build is a shipping artefact; a broken one is a broken docs surface",
  },
  {
    name: "overlay pixel guard",
    cmd: ["pnpm", "--filter", "@vibeflow-tools/ui", "run", "test", "--", "overlay"],
    why: "hostile-host-CSS + token isolation, needs the prebuilt bundle",
  },
];

const results = [];
for (const step of steps) {
  if (only && !step.name.includes(only)) continue;
  const [bin, ...args] = step.cmd;
  process.stdout.write(`\n▶ ${step.name} — ${step.why}\n`);
  const at = Date.now();
  const run = spawnSync(bin, args, { cwd: ROOT, stdio: "inherit", shell: false });
  const ms = Date.now() - at;
  const ok = run.status === 0;
  results.push({ name: step.name, ok, ms });
  if (!ok) {
    console.error(`\n✗ ${step.name} failed after ${ms} ms — stopping (fail fast)`);
    break;
  }
}

const failed = results.filter((r) => !r.ok);
console.log("\n── gate:ui summary ──");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(22)} ${(r.ms / 1000).toFixed(1)}s`);
}
console.log(`total ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failed.length ? 1 : 0);
