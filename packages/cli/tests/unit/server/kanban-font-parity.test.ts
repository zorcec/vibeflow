/**
 * Kanban font parity (ticket rrqdvoqkj5): the local board and the hosted
 * app must compute the SAME font stack and resolve the SAME vendored face.
 *
 * WHAT: `@vibeflow-tools/ui` is the single source of truth — the woff2
 * files (`packages/ui/src/kanban/fonts/`), the `@font-face` block + body
 * stack in `kanban.css`, and the `KANBAN_FONT_*` contract in `fonts.ts`.
 * The CLI inlines that CSS into the served board and serves the bytes at
 * `KANBAN_FONT_ROUTE`; the hosted app resolves the identical path from its
 * `public/` dir (hosted layout/globals asserted by hand — those files live
 * in the private repo, out of reach of this suite).
 *
 * WHY: the UI once referenced Inter by name only while the local board
 * pulled it from Google Fonts at runtime — offline/blocked networks fell
 * back to a serif face ("a font failed to load" impression, local-only).
 * Any drift here reintroduces that split, so this test fails LOUD on:
 * stale generated CSS, a reintroduced CDN link, a route regression, or a
 * hardcoded stack that bypasses the contract.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer, type Server } from "node:http";
import {
  KANBAN_FONT_FAMILY,
  KANBAN_FONT_FILES,
  KANBAN_FONT_ROUTE,
  KANBAN_FONT_STACK,
} from "@vibeflow-tools/ui/kanban";
import { KANBAN_CSS } from "../../../src/server/kanban-css.gen.js";
import { getKanbanHtml } from "../../../src/server/kanban-template.js";
import { registerFontRoute } from "../../../src/server/kanbanFonts.js";

const here = dirname(fileURLToPath(import.meta.url));
// tests/unit/server/ → packages/cli/ → repo packages/ → ui package
const UI_KANBAN_DIR = resolve(here, "../../../../ui/src/kanban");
const UI_CSS = readFileSync(join(UI_KANBAN_DIR, "kanban.css"), "utf-8");

function getBoardHtml(): string {
  const saved = process.env.VIBEFLOW_DEV;
  delete process.env.VIBEFLOW_DEV;
  try {
    return getKanbanHtml({ port: 1 });
  } finally {
    if (saved !== undefined) process.env.VIBEFLOW_DEV = saved;
  }
}

describe("kanban font parity (rrqdvoqkj5)", () => {
  it("contract: Inter-first stack with a system (never serif) fallback", () => {
    expect(KANBAN_FONT_FAMILY).toBe("Inter");
    expect(KANBAN_FONT_STACK.startsWith('"Inter",')).toBe(true);
    expect(KANBAN_FONT_STACK).toContain("-apple-system");
    expect(KANBAN_FONT_STACK.toLowerCase()).not.toContain("serif,");
    expect(KANBAN_FONT_STACK.endsWith(", sans-serif")).toBe(true);
    expect(KANBAN_FONT_FILES).toHaveLength(5);
    expect(KANBAN_FONT_ROUTE).toBe("/__vibeflow__/fonts");
  });

  it("vendored files exist on disk with byte-identical names to the contract", () => {
    for (const name of KANBAN_FONT_FILES) {
      const p = join(UI_KANBAN_DIR, "fonts", name);
      expect(existsSync(p), `${name} vendored in ui`).toBe(true);
      expect(readFileSync(p).length).toBeGreaterThan(1000);
    }
    expect(existsSync(join(UI_KANBAN_DIR, "fonts", "OFL.txt"))).toBe(true);
  });

  it("ui kanban.css carries the @font-face block and the exact contract stack", () => {
    for (const name of KANBAN_FONT_FILES) {
      const weight = name.match(/inter-(\d+)\.woff2/)?.[1];
      expect(weight).toBeTruthy();
      expect(UI_CSS).toContain(`url("${KANBAN_FONT_ROUTE}/${name}")`);
      expect(UI_CSS).toContain(`font-weight: ${weight};`);
    }
    expect(UI_CSS).toContain(`font-family: ${KANBAN_FONT_STACK};`);
    expect(UI_CSS).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it("generated KANBAN_CSS matches the source (fails when regen was skipped)", () => {
    for (const name of KANBAN_FONT_FILES) {
      expect(KANBAN_CSS).toContain(`${KANBAN_FONT_ROUTE}/${name}`);
    }
    // Minified: quotes dropped, `, ` collapsed to `,`; inner spaces kept.
    const minified = KANBAN_FONT_STACK.replaceAll('"', "").replaceAll(", ", ",");
    expect(KANBAN_CSS).toContain(`font-family:${minified}`);
    expect(KANBAN_CSS).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it("board HTML has no CDN font link and references the vendored route", () => {
    const html = getBoardHtml();
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    // The @font-face URLs are absolute, so they survive inlining verbatim.
    expect(html).toContain(`${KANBAN_FONT_ROUTE}/inter-400.woff2`);
  });

  it("client inline fallbacks use the contract, not a hardcoded stack", () => {
    const cliSrc = resolve(here, "../../../src/client/kanban");
    for (const file of ["App.tsx", "error-boundary.tsx"]) {
      const src = readFileSync(join(cliSrc, file), "utf-8");
      expect(src).toContain("KANBAN_FONT_STACK");
      expect(src).not.toMatch(/fontFamily:\s*"Inter/);
    }
  });

  describe("font route", () => {
    let server: Server;
    let base: string;

    beforeAll(async () => {
      const app = express();
      registerFontRoute(app);
      server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    });

    it("serves every vendored weight as immutable woff2", async () => {
      for (const name of KANBAN_FONT_FILES) {
        const res = await fetch(`${base}${KANBAN_FONT_ROUTE}/${name}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("font/woff2");
        expect(res.headers.get("cache-control")).toContain("immutable");
        expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
      }
    });

    it("404s unknown names (no listing, no traversal)", async () => {
      for (const bad of ["inter-800.woff2", "Inter.woff2", "..", "package.json"]) {
        const res = await fetch(`${base}${KANBAN_FONT_ROUTE}/${bad}`);
        expect(res.status).toBe(404);
      }
    });
  });
});
