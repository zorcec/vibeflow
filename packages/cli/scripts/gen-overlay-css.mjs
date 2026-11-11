#!/usr/bin/env node
/**
 * Generates the :host token block in src/client/overlay.css plus
 * src/client/overlay-css.gen.ts from the CSS source files.
 * Run automatically via the "prebuild" npm script before every tsup build.
 *
 * Token source of truth: packages/ui/src/kanban/themes.css, the same file
 * the board consumes. The overlay renders inside a shadow root, and
 * `:host { all: initial }` does NOT reset custom properties — they inherit
 * straight through the shadow boundary. So a hostile host page that declares
 * `--t-bg`, `--p-text`, or any `--vibeflow-*` on `:root` would repaint the
 * overlay. The generated block re-declares the whole namespace on `:host`
 * (dark defaults — the overlay is forced dark, owner decision #8), so the
 * overlay's own values always win the cascade. No hand-copied values: this
 * script is the only writer of the marked region in overlay.css.
 *
 * Both the generated TS file and the showcase HTML link to the same sources.
 */
import { execSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The board's token source — same file the kanban pipeline inlines.
const themesCssPath = resolve(root, "../../packages/ui/src/kanban/themes.css");
const overlayCssPath = resolve(root, "src/client/overlay.css");
const hostCssPath = resolve(root, "src/client/overlay-host.css");

const BEGIN_MARKER =
  "/* __OVERLAY_HOST_TOKENS_BEGIN__ — generated from packages/ui/src/kanban/themes.css (:root dark defaults). DO NOT EDIT — run `node scripts/gen-overlay-css.mjs`. */";
const END_MARKER = "/* __OVERLAY_HOST_TOKENS_END__ */";

/**
 * Extract the dark-default `:root { ... }` block from themes.css — the first
 * block whose selector line is exactly `:root {`. (The file also contains a
 * `:root:not([data-theme])` block inside a prefers-color-scheme media query
 * and per-theme `[data-theme="..."]` blocks; none of those may leak in.)
 */
function extractDarkRootBlock(themesCss) {
  const lines = themesCss.split("\n");
  const start = lines.findIndex((l) => l.trim() === ":root {");
  if (start === -1) {
    throw new Error(
      `[gen-overlay-css] no dark-default ":root {" block found in ${themesCssPath}`,
    );
  }
  // The dark block is the first :root rule in the file; anything after the
  // next closing brace at column 0 ends it.
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "}") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new Error(
      `[gen-overlay-css] unterminated ":root {" block in ${themesCssPath}`,
    );
  }
  return lines.slice(start + 1, end).join("\n");
}

/**
 * Parse `--p-*` / `--t-*` declarations (name + raw value) in order.
 * Values are copied verbatim — including `var(--p-*)` aliases and
 * `color-mix()` expressions — so the overlay can never drift from the board.
 * Verbatim aliases stay correct inside the shadow tree because the whole
 * `--p-*` tier is re-declared on the same `:host` rule they resolve against.
 */
function parseTokenDeclarations(block) {
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const decls = [];
  for (const m of withoutComments.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2].trim();
    if (name.startsWith("--p-") || name.startsWith("--t-")) {
      decls.push({ name, value });
    }
  }
  return decls;
}

const themesCss = readFileSync(themesCssPath, "utf-8");
const darkBlock = extractDarkRootBlock(themesCss);
const tokens = parseTokenDeclarations(darkBlock);
if (tokens.length < 50) {
  throw new Error(
    `[gen-overlay-css] parsed only ${tokens.length} tokens from the dark :root block — expected the full namespace (refusing to emit a partial block)`,
  );
}
const names = tokens.map((t) => t.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length > 0) {
  throw new Error(
    `[gen-overlay-css] duplicate token names in dark :root block: ${[...new Set(dupes)].join(", ")}`,
  );
}

const tokenLines = tokens.map(({ name, value }) => `  ${name}: ${value};`);
const generatedRegion = [BEGIN_MARKER, ...tokenLines, END_MARKER].join("\n");

// Splice the generated region into overlay.css between its markers.
const overlayCSS = readFileSync(overlayCssPath, "utf-8");
const beginIdx = overlayCSS.indexOf(BEGIN_MARKER);
const endIdx = overlayCSS.indexOf(END_MARKER);
if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
  throw new Error(
    `[gen-overlay-css] token markers missing in ${overlayCssPath} — expected ${"__OVERLAY_HOST_TOKENS_BEGIN__"}/${"__OVERLAY_HOST_TOKENS_END__"} inside the :host rule`,
  );
}
const refreshedOverlayCss =
  overlayCSS.slice(0, beginIdx) +
  generatedRegion +
  overlayCSS.slice(endIdx + END_MARKER.length);
if (refreshedOverlayCss !== overlayCSS) {
  writeFileSync(overlayCssPath, refreshedOverlayCss, "utf-8");
  console.log(
    `[gen-overlay-css] Refreshed :host token block in src/client/overlay.css (${tokens.length} tokens)`,
  );
} else {
  console.log(
    `[gen-overlay-css] :host token block in src/client/overlay.css already current (${tokens.length} tokens)`,
  );
}

const hostCSS = readFileSync(hostCssPath, "utf-8");

// Safely escape for template literals
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

// ── P7.2: primitives utility subset ─────────────────────────────────────
// The overlay's shadow root carries no Tailwind utilities (overlay.css is
// hand-written), so a shared primitive styled with utilities — e.g.
// cn("px-4", "px-6"), a `flex gap-2` container, a `rounded-lg` chip —
// renders unstyled there. Same Tailwind v4 pipeline as the board
// (gen-kanban-css.mjs): `source(none)` + explicit absolute @sources
// restricted to the files the overlay actually renders, with the shared
// token→utility map (primitives/theme.css) inlined so token-bound
// utilities (bg-accent) keep their var() reference and resolve against
// the :host block above. `theme` + `utilities` only — no preflight, so the
// overlay's own reset stays the single reset in the shadow tree.
// The asserted probe classes are pinned via `@source inline(...)`:
// content detection only sees static source files, and the probe elements
// are created dynamically by tests/playwright/overlay-primitives.test.ts.
// Keep the pinned set in sync with that test.
const utilStart = performance.now();
const primitivesThemePath = resolve(
  root,
  "../../packages/ui/src/primitives/theme.css",
);
const overlaySources = [
  resolve(root, "src/client/overlay-browser"),
  resolve(root, "src/client/overlay-react"),
  resolve(root, "src/client/shared"),
  resolve(root, "../../packages/ui/src/primitives"),
  resolve(root, "../../packages/ui/src/ChatPanel.tsx"),
];
const PINNED_UTILITIES = "px-4 px-6 flex gap-2 rounded-lg bg-accent";
const tmpUtilInput = resolve(
  tmpdir(),
  `overlay-utils-${randomBytes(8).toString("hex")}.css`,
);
const tmpUtilOutput = `${tmpUtilInput}.out.css`;
writeFileSync(
  tmpUtilInput,
  [
    `@import "tailwindcss/theme" source(none);`,
    `@import "tailwindcss/utilities" source(none);`,
    ...overlaySources.map((p) => `@source "${p}";`),
    `@source inline("${PINNED_UTILITIES}");`,
    readFileSync(primitivesThemePath, "utf-8"),
  ].join("\n"),
  "utf-8",
);
execSync(
  `npx @tailwindcss/cli -i "${tmpUtilInput}" -o "${tmpUtilOutput}" --minify`,
  { cwd: root, stdio: "inherit" },
);
const utilCss = readFileSync(tmpUtilOutput, "utf-8");
try {
  unlinkSync(tmpUtilInput);
  unlinkSync(tmpUtilOutput);
} catch {}
const utilMs = Math.round(performance.now() - utilStart);
// Share of the board's CSS: the previous build's KANBAN_CSS when present,
// else the staged board artifact. Board CSS is minified, so the ratio is
// minified-to-minified.
let boardBytes = 0;
try {
  const kanbanGen = readFileSync(
    resolve(root, "src/server/kanban-css.gen.ts"),
    "utf-8",
  );
  const m = kanbanGen.match(/KANBAN_CSS = `([\s\S]*?)`;\s*$/);
  boardBytes = m ? m[1].length : 0;
} catch {}
const utilBytes = utilCss.length;
const share = boardBytes > 0 ? ((utilBytes / boardBytes) * 100).toFixed(1) : "?";
console.log(
  `[gen-overlay-css] utility subset: ${utilBytes} bytes (${share}% of board CSS ${boardBytes} bytes) in ${utilMs}ms`,
);

const output = `// AUTO-GENERATED by scripts/gen-overlay-css.mjs — DO NOT EDIT MANUALLY.
// Edit src/client/overlay.css or src/client/overlay-host.css instead, then run 'npm run build'.
// The :host token block inside overlay.css is itself generated from
// packages/ui/src/kanban/themes.css (same source the board uses).
// OVERLAY_UTIL_CSS is the compiled Tailwind utility subset for primitives
// rendered in the shadow root (see the P7.2 section in the generator).

/** CSS for the Shadow DOM overlay host. Injected into a <style> inside :host */
export const OVERLAY_CSS = \`${esc(refreshedOverlayCss)}\`;

/** CSS injected into the host document for annotation-mode hover highlights. */
export const HOST_PAGE_CSS = \`${esc(hostCSS)}\`;

/** Compiled Tailwind utility subset for shared primitives in the shadow root.
    Injected as a second <style> after OVERLAY_CSS (see overlay-browser/ui.ts). */
export const OVERLAY_UTIL_CSS = \`${esc(utilCss)}\`;
`;

writeFileSync(resolve(root, "src/client/overlay-css.gen.ts"), output, "utf-8");
console.log("[gen-overlay-css] Generated src/client/overlay-css.gen.ts");
