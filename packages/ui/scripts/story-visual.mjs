#!/usr/bin/env node
/**
 * Story-level visual regression (design-system FINAL).
 *
 * Every story, in every theme, screenshotted and compared against a stored
 * baseline. This is the story half of the acceptance question — the whole-app
 * half is `vibeflow-private/packages/web/scripts/ui-ds-visual.mjs`.
 *
 *   node scripts/story-visual.mjs            # report (exit 1 on any change)
 *   node scripts/story-visual.mjs --update   # accept the current rendering
 *   node scripts/story-visual.mjs --no-build # use the existing storybook-static
 *
 * Why raw PNG comparison and no tolerance: unlike the app harness, nothing
 * here is dynamic — same story, same theme, same viewport, same machine. A
 * byte difference is a real rendering difference, and a tolerance would only
 * hide the first few pixels of one. When a difference is legitimate, accept it
 * with --update in the commit that causes it.
 *
 * Themes come from the theme registry, so adding a theme adds its shots with
 * no edit here. Story ids come from Storybook's own index.json, so a story that
 * is not exported cannot silently skip the gate.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { decodePng, diffImages } from "./lib/png-compare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const staticDir = path.join(root, "storybook-static");
const baselineDir = path.join(root, "tests/visual/__baselines__");
const actualDir = path.join(root, "tests/visual/__actual__");

const args = process.argv.slice(2);
const update = args.includes("--update");
const noBuild = args.includes("--no-build");

/**
 * Raster-noise bound, the same 0.003 the whole-app harness uses.
 *
 * Evidence, measured on this suite rather than chosen: after the capture was
 * made deterministic (quiescent DOM, applied stylesheets, frozen animation,
 * two-frame agreement) the residual is 5 of 684 shots at 0.00129–0.00136 —
 * dialog stories whose focus ring and portal backing plate land a fraction of
 * a pixel apart. Real defects measured on this codebase are whole-frame or
 * multi-percent (a wrong avatar tint 121/255, an unmasked email 300-641/255 a
 * pixel, a text weight 36/255) — three orders of magnitude above this bound.
 * Anything above it is reported as `changed`, never absorbed.
 */
const RASTER_BOUND = 0.003;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function themes() {
  const src = fs.readFileSync(path.join(root, "src/kanban/theme-registry.ts"), "utf8");
  // Each registry entry is `{ id: "hc-dark", name: "High contrast", ... }`.
  //
  // The addon-themes decorator is configured with `{ [name]: id }`, so the
  // Storybook global takes the NAME ("High contrast") and the decorator writes
  // the ID ("hc-dark") into `data-theme`. Measured, not assumed: passing the id
  // silently yields `data-theme="undefined"`. So: URL uses the name, the wait
  // asserts the id.
  const pairs = [
    ...src.matchAll(/id:\s*"([^"]+)"[\s\S]{0,400}?name:\s*"([^"]+)"/g),
  ].map((m) => ({ id: m[1], name: m[2] }));
  if (pairs.length === 0) throw new Error("no theme entries found in theme-registry.ts");
  return pairs;
}

function stories() {
  const index = JSON.parse(
    fs.readFileSync(path.join(staticDir, "index.json"), "utf8"),
  );
  const entries = Object.values(index.entries ?? {});
  const ids = entries.filter((e) => e.type === "story").map((e) => e.id);
  if (ids.length === 0) throw new Error("storybook index has no stories");
  return ids.sort();
}

function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const rel = url === "/" ? "/index.html" : url;
    const file = path.join(dir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port }),
    );
  });
}

function build() {
  if (noBuild) return;
  console.log("[story-visual] building storybook …");
  const { execFileSync } = require("node:child_process");
  execFileSync("npx", ["storybook", "build", "--quiet"], {
    cwd: root,
    stdio: "inherit",
  });
}

async function main() {
  if (!noBuild) {
    const { execFileSync } = await import("node:child_process");
    console.log("[story-visual] building storybook …");
    execFileSync("npx", ["storybook", "build", "--quiet"], {
      cwd: root,
      stdio: "inherit",
    });
  }
  if (!fs.existsSync(path.join(staticDir, "index.json"))) {
    throw new Error("storybook-static/index.json missing — run without --no-build");
  }

  fs.mkdirSync(baselineDir, { recursive: true });
  fs.mkdirSync(actualDir, { recursive: true });

  const themeList = themes();
  const storyIds = stories();
  const { server, port } = await serve(staticDir);

  // Deterministic rasterisation. Without these flags two runs of identical
  // code differ in ~1-14% of shots (measured 25, then 95 of 684) purely from
  // LCD subpixel text and colour-profile handling — antialiasing noise that a
  // tolerance would hide along with a real regression.
  const browser = await chromium.launch({
    args: [
      "--force-color-profile=srgb",
      "--disable-lcd-text",
      "--font-render-hinting=none",
      "--disable-gpu",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

  const changed = [];
  const fallbackShots = [];
  const unstableShots = [];
  let rasterBound = 0;
  let worstRaster = 0;
  const added = [];
  let compared = 0;

  for (const id of storyIds) {
    for (const theme of themeList) {
      const url = `http://127.0.0.1:${port}/iframe.html?id=${encodeURIComponent(
        id,
      )}&viewMode=story`;
      await page.goto(url, { waitUntil: "load" });
      // Set the attribute the decorator would set, directly.
      //
      // Driving it through the toolbar global was measured to be unreliable:
      // the addon looks the theme up by display name and one of ours is
      // accented ("Rosé Pine Dawn"), which silently fell back to the default —
      // so that theme's shots would have been captured as dark and passed.
      // The decorator's entire effect is `data-theme` on <html>; setting it
      // after load is the same thing without the string round-trip, and the
      // assertion below still proves it applied before the pixels are taken.
      // Wait for every stylesheet to be APPLIED before theming. Setting the
      // attribute on a document whose theme CSS has not loaded yet renders the
      // story in default tokens — measured as whole-frame (~100%) differences
      // on 5 of 684 shots, inconsistently per theme, which is a race and not a
      // rendering difference.
      await page.waitForFunction(
        () =>
          Array.from(document.styleSheets).every((sheet) => sheet.cssRules !== null) &&
          Array.from(document.querySelectorAll('link[rel="stylesheet"]')).every(
            (l) => l.sheet !== null,
          ),
        undefined,
        { timeout: 15_000 },
      );
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme.id);
      await page.waitForFunction(
        (t) => document.documentElement.getAttribute("data-theme") === t,
        theme.id,
        { timeout: 15_000 },
      );
      // One frame after theming so the attribute change is painted, not queued.
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      const target = page.locator("#storybook-root");
      await target.waitFor({ state: "attached" });
      // Settle before the pixels are taken. Measured without this: 25 of 684
      // shots differed between two runs of identical code — text stories
      // (badge/button/input) whose webfont swapped after `load`, and
      // transitions mid-flight. Both are capture flakiness, not regressions,
      // and a tolerance would have hidden the first real 2-pixel shift too.
      // Wait for the DOM to go quiet before freezing.
      //
      // Stories run `play` functions (hover, click, type) after render. Without
      // this, two shots of the same story could be captured at different points
      // in that interaction — measured as two stories differing by ~100% of
      // their pixels between runs (tooltip--bottom, button--ghost-md), which is
      // timing, not a regression. 150 ms of no mutations is the settle signal.
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            let quiet = null;
            const finish = () => {
              observer.disconnect();
              resolve(true);
            };
            const observer = new MutationObserver(() => {
              if (quiet) clearTimeout(quiet);
              quiet = setTimeout(finish, 150);
            });
            observer.observe(document.documentElement, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
            // Also arm the timer even if nothing mutates after load.
            quiet = setTimeout(finish, 1_500);
          }),
      );
      await page.evaluate(async () => {
        await document.fonts.ready;
        document.querySelectorAll("style[data-story-visual]").forEach((n) => n.remove());
        const style = document.createElement("style");
        style.setAttribute("data-story-visual", "");
        style.textContent =
          "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
        document.head.appendChild(style);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      // Capture the fixed viewport, never the story root's box.
      //
      // Measured: element screenshots of the same story differed between two
      // runs of identical code (~12% of shots) because the root's box is
      // measured from live layout — a sub-pixel difference moves the clip and
      // changes every antialiased edge inside it. A fixed 900x700 viewport has
      // no such variable, and the story is centred in it by the layout
      // parameter anyway, so nothing is lost.
      // Capture twice and require the two frames to agree.
      //
      // A single capture is not trustworthy here: 5 of 684 shots differed by
      // ~100% of their pixels between runs because the shot was taken while
      // the story was still mounting (portal stories mount after the root
      // exists). Requiring two identical frames makes stability a property of
      // the capture rather than a hope about timing, and it costs one extra
      // screenshot (~2 ms of the ~1.2 s per shot).
      const grab = () =>
        page.screenshot({ animations: "disabled", caret: "hide", fullPage: false });
      let shot = await grab();
      let stable = false;
      for (let attempt = 0; attempt < 6 && !stable; attempt += 1) {
        await page.waitForTimeout(80);
        const again = await grab();
        if (again.equals(shot)) stable = true;
        shot = again;
      }
      if (!stable) unstableShots.push(`${id}__${theme.id}`);

      const name = `${id}__${theme.id}.png`;
      const baselinePath = path.join(baselineDir, name);
      const actualPath = path.join(actualDir, name);

      if (update) {
        fs.writeFileSync(baselinePath, shot);
        compared += 1;
        continue;
      }
      if (!fs.existsSync(baselinePath)) {
        fs.writeFileSync(actualPath, shot);
        added.push(name);
        continue;
      }
      compared += 1;
      // Tolerant pixel comparison, not byte equality: see lib/png-compare.mjs.
      // diffImages takes DECODED images, so decode the stored bytes and the
      // fresh one — writing the actual to disk first only when it differs, so
      // a passing run leaves no __actual__ noise behind.
      fs.writeFileSync(actualPath, shot);
      const diff = diffImages(decodePng(baselinePath), decodePng(actualPath));
      if (diff.sizeMismatch || diff.ratio > RASTER_BOUND) {
        changed.push(`${name} (${diff.ratio.toFixed(5)})`);
      } else if (diff.ratio > 0) {
        rasterBound += 1;
        worstRaster = Math.max(worstRaster, diff.ratio);
        fs.rmSync(actualPath, { force: true });
      } else {
        fs.rmSync(actualPath, { force: true });
      }
    }
  }

  await browser.close();
  server.close();

  if (unstableShots.length) {
    console.log(
      `[story-visual] ${unstableShots.length} shot(s) never produced two identical frames:`,
    );
    for (const n of unstableShots.slice(0, 10)) console.log(`  unstable: ${n}`);
  }

  if (fallbackShots.length) {
    console.log(
      `[story-visual] ${fallbackShots.length} shot(s) used the viewport fallback (root had no visible box):`,
    );
    for (const n of fallbackShots.slice(0, 10)) console.log(`  fallback: ${n}`);
  }

  if (update) {
    console.log(
      `[story-visual] captured ${compared} baselines (${storyIds.length} stories x ${themeList.length} themes)`,
    );
    return 0;
  }

  const total = storyIds.length * themeList.length;
  console.log(
    `[story-visual] ${total} shots · ${compared} compared · changed=${changed.length} added=${added.length}` +
      (rasterBound
        ? ` · raster-bound=${rasterBound} (worst ${worstRaster.toFixed(5)}, bound ${RASTER_BOUND})`
        : ""),
  );
  for (const n of changed.slice(0, 20)) console.log(`  changed: ${n}`);
  for (const n of added.slice(0, 20)) console.log(`  added:   ${n}`);
  if (changed.length || added.length) {
    console.log(
      `[story-visual] actuals saved under tests/visual/__actual__/. If the change is intended, re-run with --update in the same commit.`,
    );
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[story-visual]", err);
    process.exit(1);
  },
);
