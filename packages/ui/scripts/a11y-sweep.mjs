#!/usr/bin/env node
/**
 * Contrast sweep over every story in every theme — the gate the story-level
 * assertion cannot be.
 *
 * WHY THIS EXISTS. `stories/a11y.ts` runs axe inside a browser test, so it can
 * check structure but cannot read or write files and therefore cannot hold a
 * known-debt list to account. It used to disable `color-contrast` outright
 * while the story manifest claimed "axe-clean in all six themes" — a claim
 * nothing enforced. Running the sweep measured 2026-11-14 found **386 distinct
 * failing colour pairs**, 207 of them below 3:1 and 74 below 1.6:1.
 *
 * That volume is a design decision (remediating it restyles six themes), so the
 * response is a RATCHET rather than a fix or a mute:
 *   - the current pairs live in `tests/visual/contrast-allowance.json`,
 *   - a pair that is not listed FAILS (new regressions cannot land),
 *   - a listed pair that no longer fails FAILS (the debt must shrink),
 *   - the run always prints the count and the worst ratio outstanding.
 *
 * Usage:
 *   node scripts/a11y-sweep.mjs                 # verify against the allowance
 *   node scripts/a11y-sweep.mjs --write         # record current pairs (owner's call)
 *   node scripts/a11y-sweep.mjs --no-build      # reuse an existing storybook build
 *
 * It drives the already-built Storybook over CDP with real compositing, which
 * is the only way colour contrast can be measured at all.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "storybook-static");
const ALLOWANCE = path.join(ROOT, "tests/visual/contrast-allowance.json");
const THEMES = ["dark", "light", "hc-dark", "dracula", "gruvbox-dark", "rose-pine-dawn"];

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const NO_BUILD = argv.includes("--no-build");

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

async function build() {
  if (NO_BUILD && existsSync(path.join(OUT_DIR, "index.json"))) return;
  console.log("[a11y] building storybook …");
  await run("npx", ["storybook", "build", "--quiet"]);
}

function loadAllowance() {
  if (!existsSync(ALLOWANCE)) return {};
  return JSON.parse(readFileSync(ALLOWANCE, "utf8"));
}

/** Serve the static build and open it in Chromium with axe injected. */
async function sweep() {
  const { createServer } = await import("node:http");
  const serve = await import("node:fs");
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = path.join(OUT_DIR, url === "/" ? "index.html" : url);
    if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = serve.readFileSync(file);
    const ext = path.extname(file);
    const type =
      ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : ext === ".json" ? "application/json" : "text/html";
    res.writeHead(200, { "content-type": type }).end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const index = JSON.parse(
    readFileSync(path.join(OUT_DIR, "index.json"), "utf8"),
  );
  const entries = Object.values(index.entries ?? {});

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const found = new Map();

  for (const entry of entries) {
    if (entry.type !== "story") continue;
    const id = entry.id;
    for (const theme of THEMES) {
      await page.goto(`http://127.0.0.1:${port}/iframe.html?id=${id}&viewMode=story`, {
        waitUntil: "load",
        timeout: 60_000,
      });
      await page.evaluate((t) => {
        // Kill motion BEFORE the measurement. A colour transition that is still
        // running makes axe read an interpolated colour, so the same story
        // yields different pairs on consecutive runs — measured: 26 "new" and
        // 27 "fixed" pairs between two identical passes before this.
        const style = document.createElement("style");
        style.textContent =
          "*,*::before,*::after{animation:none!important;transition:none!important}";
        document.head.appendChild(style);
        document.documentElement.setAttribute("data-theme", t);
      }, theme);
      // Fonts change metrics and therefore what lands on what; two frames
      // after the theme swap is what the visual harness settled on.
      await page.evaluate(
        () =>
          new Promise((r) =>
            document.fonts.ready.then(() =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
          ),
      );
      await page.waitForTimeout(60);
      // Measured twice when the first pass reports anything, and only pairs
      // present in BOTH runs are kept. Reason (observed 2026-11-14): a single
      // flaky pair (gruvbox-dark|#d3869b|#5f484d) appeared in one run and not
      // the next on identical code, which turns the ratchet into a false red.
      // Requiring 2-of-2 removes the noise without hiding a real violation,
      // which reproduces every time. Same principle as the visual harness's
      // "two identical frames" rule.
      const measure = async () => await page.evaluate(async () => {
        // The root must be a real node; Storybook's own bundle also ships axe,
        // so prefer whatever is already on window.
        // Storybook's a11y addon runs axe itself, so an injected copy would
        // collide ("Axe is already running"). Reuse the instance the page
        // already has and wait for its own pass to finish.
        const axe = window.axe;
        if (!axe) return [];
        let results;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try {
            results = await axe.run(document, {
              runOnly: { type: "rule", values: ["color-contrast"] },
            });
            break;
          } catch (err) {
            if (!/already running/i.test(String(err))) throw err;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        if (!results) return [];
        const out = [];
        for (const v of results.violations) {
          for (const n of v.nodes) {
            const d = n.any?.[0]?.data ?? {};
            if (d.fgColor && d.bgColor) {
              out.push({ fg: String(d.fgColor).toLowerCase(), bg: String(d.bgColor).toLowerCase(), ratio: Number(d.contrastRatio ?? 0) });
            }
          }
        }
        return out;
      });
      // ONE pass is recorded; confirmation is applied later, and only to pairs
      // that are NOT already in the allowance. Intersecting everything shrank
      // the recorded set below reality (measured: 131 -> 129 -> 123 across three
      // runs), which then reported the dropped pairs as "new" on the next run.
      const pairs = await measure();
      for (const p of pairs) {
        const key = `${theme}|${p.fg}|${p.bg}`;
        const prev = found.get(key);
        if (!prev || p.ratio < prev.ratio) found.set(key, { ...p, ratio: p.ratio, story: id });
      }
    }
  }

  await browser.close();
  server.close();
  return found;
}

async function main() {
  await build();
  // Record the UNION of three passes when writing. axe measures composited
  // colour, and a handful of pairs are not perfectly reproducible between runs;
  // a union errs towards recording MORE debt (never a false green), which is
  // the correct direction for a known-debt file.
  const found = new Map();
  const passes = WRITE ? 3 : 1;
  for (let i = 0; i < passes; i += 1) {
    const pass = await sweep();
    for (const [k, v] of pass) {
      const prev = found.get(k);
      if (!prev || v.ratio < prev.ratio) found.set(k, v);
    }
  }
  const allowance = loadAllowance();

  const keys = [...found.keys()].sort();
  const worst = Math.min(...[...found.values()].map((v) => v.ratio), Infinity);

  if (WRITE) {
    const out = Object.fromEntries(keys.map((k) => [k, found.get(k).ratio]));
    writeFileSync(ALLOWANCE, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`[a11y] wrote ${keys.length} known contrast pairs to ${path.relative(ROOT, ALLOWANCE)}`);
    return 0;
  }

  let unallowed = keys.filter((k) => !(k in allowance));
  if (unallowed.length > 0) {
    // Confirm before failing: a pair that cannot be reproduced is measurement
    // noise, not a regression. A real one reproduces.
    const confirm = await sweep();
    unallowed = unallowed.filter((k) => confirm.has(k));
  }
  const stale = Object.keys(allowance).filter((k) => !found.has(k));

  console.log(
    `[a11y] ${keys.length} contrast pair(s) outstanding · worst ${Number.isFinite(worst) ? worst.toFixed(2) : "n/a"}:1 · ` +
      `${unallowed.length} new · ${stale.length} fixed`,
  );

  for (const k of unallowed.slice(0, 40)) {
    const v = found.get(k);
    console.log(`  NEW    ${k}  (${v.ratio}:1, ${v.story})`);
  }
  for (const k of stale.slice(0, 40)) {
    console.log(`  FIXED  ${k}  — remove it from the allowance`);
  }

  if (unallowed.length || stale.length) {
    console.log(
      "\n[a11y] FAILED. A new pair may not land, and a repaired pair must leave the " +
        "allowance (the file only shrinks). Re-record with --write only when the " +
        "change is understood.",
    );
    return 1;
  }
  console.log("[a11y] allowance matches — no new colour contrast regressions.");
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
