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
    // The script is `storybook:build` in packages/ui/package.json; this gate
    // called `build-storybook`, which no package defines, so the gate could
    // never pass and its last stage always reported FAIL (found while
    // reviewing the phone-width work, ticket 45a8e57c).
    cmd: ["pnpm", "--filter", "@vibeflow-tools/ui", "run", "storybook:build"],
    why: "the static build is a shipping artefact; a broken one is a broken docs surface",
  },
  {
    name: "overlay pixel guard",
    cmd: ["pnpm", "--filter", "@vibeflow-tools/ui", "run", "test", "--", "overlay"],
    why: "hostile-host-CSS + token isolation, needs the prebuilt bundle",
  },
  {
    // The contrast ratchet used to live in `.github/workflows/a11y.yml`. GitHub
    // Actions is not used in this repo at all (ticket cusivd86k), so the check
    // moved here — this gate is the only "slow lane" that can afford a
    // Storybook build plus composited measurements, and it already claims in
    // its own header to run the a11y sweep.
    //
    // Why it must exist somewhere: `packages/ui/scripts/a11y-sweep.mjs` protects
    // nothing if nothing runs it. A colour pair NOT in the allowance fails (a
    // new regression cannot land) and a pair IN the allowance that no longer
    // fails also fails (the file may only shrink). jsdom cannot composite, so
    // this cannot be folded into the fast suite — the cost is real, and it is
    // the price of measuring contrast honestly.
    name: "contrast ratchet (a11y)",
    cmd: ["pnpm", "--filter", "@vibeflow-tools/ui", "run", "test:a11y"],
    why: "replaced the GitHub Actions workflow; needs the storybook build above",
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
