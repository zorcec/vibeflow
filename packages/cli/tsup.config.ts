import { defineConfig } from "tsup";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

// Build-output dir honouring the atomic-build staging override (ticket
// 328b5420): scripts/build-atomic.mjs sets VIBEFLOW_DIST_DIR=dist.next so
// the bundles land in the staging tree; unset means the live dist/ as before.
const DIST = process.env.VIBEFLOW_DIST_DIR || "dist";

export default defineConfig([
  // Browser overlay bundle (built first — generates overlay-bundle.gen.ts for CLI)
  {
    entry: { "overlay-browser": "src/client/overlay-browser/index.ts" },
    format: ["iife"],
    target: "chrome90",
    platform: "browser",
    outDir: `${DIST}/client`,
    clean: false,
    sourcemap: false,
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    noExternal: [/.*/],
    esbuildOptions(options) {
      // JSX support needed for React overlay components imported from overlay-react/
      options.define = {
        "process.env.NODE_ENV": '"production"',
        // The @jsquash Emscripten glue evaluates
        // `new URL("<codec>.wasm", import.meta.url)` at module top level.
        // In an inlined IIFE import.meta.url is invalid and throws, which
        // would break every image transform. The wasm bytes are always
        // supplied via manual instantiation (never fetched relative to
        // this URL), so a dummy valid URL is safe — and nothing else in
        // the client bundles uses import.meta.
        "import.meta.url": '"file:///vibeflow-bundle/"',
      };
      options.outExtension = { ".js": ".js" };
    },
    onSuccess: async () => {
      const bundle = readFileSync(`${DIST}/client/overlay-browser.js`, "utf-8");
      const bundleExport = `// AUTO-GENERATED — run 'npm run build' to regenerate. Do not edit manually.\nexport const OVERLAY_BROWSER_BUNDLE = ${JSON.stringify(bundle)};\n`;
      writeFileSync("src/client/overlay-bundle.gen.ts", bundleExport);
      // Also write to packages/shared so the SaaS can import it at build time.
      writeFileSync("../../packages/shared/src/overlay-bundle.gen.ts", bundleExport);
      // Copy the single-source CSS files so external tools (showcase, devtools) can link them directly
      cpSync("src/client/overlay.css", `${DIST}/overlay.css`);
      cpSync("src/client/overlay-host.css", `${DIST}/overlay-host.css`);
      // Remove stale CSS/global artifacts from the output client dir (clean: false is needed for multi-target)
      for (const stale of [`${DIST}/client/overlay-browser.css`, `${DIST}/client/overlay-browser.global.js`]) {
        if (existsSync(stale)) rmSync(stale);
      }
      console.log("[tsup] Generated src/client/overlay-bundle.gen.ts");
    },
  },
  // Kanban React IIFE bundle (built second — generates kanban-bundle.gen.ts for server)
  {
    entry: { "kanban-browser": "src/client/kanban/index.tsx" },
    format: ["iife"],
    target: "chrome90",
    platform: "browser",
    outDir: `${DIST}/client`,
    clean: false,
    sourcemap: false,
    minify: true,
    noExternal: [/.*/],
    esbuildOptions(options) {
      // Production mode — jsxDev is intentionally disabled to avoid embedding
      // absolute build-machine source paths into the published npm package.
      options.define = {
        "process.env.NODE_ENV": '"production"',
        // Same Emscripten import.meta.url fix as the overlay entry above:
        // the kanban bundle is inlined into served HTML, so the module URL
        // is invalid at runtime; wasm bytes are manually instantiated.
        "import.meta.url": '"file:///vibeflow-bundle/"',
      };
      options.outExtension = { ".js": ".js" };
    },
    onSuccess: async () => {
      const bundle = readFileSync(`${DIST}/client/kanban-browser.js`, "utf-8");
      writeFileSync(
        "src/server/kanban-bundle.gen.ts",
        `// AUTO-GENERATED — run 'npm run build' to regenerate. Do not edit manually.\n/** Production React+Tailwind kanban bundle. Inlined into the HTML shell at build time. */\nexport const KANBAN_BUNDLE = ${JSON.stringify(bundle)};\n`,
      );
      console.log("[tsup] Generated src/server/kanban-bundle.gen.ts");
    },
  },
]);
