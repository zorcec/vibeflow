/**
 * Kanban dev mode (ticket 7e85c338): editing the kanban client refreshes the
 * browser with NO server restart.
 *
 * WHAT: in dev (explicit `--dev` / `ServeOptions.dev` / `VIBEFLOW_DEV=1` ONLY)
 * the board HTML references the on-disk bundle as a separate no-store asset
 * (`/__vibeflow__/kanban-dev.js`) instead of the production inlined
 * megastring, and the server broadcasts `{ type: "kanban-reload" }` on the
 * existing task-sync websocket whenever `tsup --watch` rewrites the bundle —
 * the dev shell reloads the page on that frame. Production (default) keeps
 * the EXACT single-file inlined bundle.
 *
 * WHY: `tsup --watch` rebuilt on change, but the running server kept serving
 * the stale inlined copy — watch without effect (the class the staleness
 * guard in kanban-template.ts warns about).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getKanbanHtml,
  isKanbanDevMode,
  resolveKanbanDevBundlePath,
  readKanbanDevBundle,
  KANBAN_DEV_BUNDLE_ROUTE,
  KANBAN_RELOAD_MESSAGE_TYPE,
  KANBAN_DEV_BUNDLE_MISSING,
} from "../../../src/server/kanban-template.js";
import { KANBAN_BUNDLE } from "../../../src/server/kanban-bundle.gen.js";
import { notifyKanbanBundleRebuilt } from "../../../src/server/server.js";

const DEV_ENV_VARS = ["VIBEFLOW_DEV", "VIBEFLOW_KANBAN_DEV_BUNDLE"] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of DEV_ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of DEV_ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

/** Points the dev-bundle seam at a temp marker file; returns the dir. */
function seedDevBundle(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-dev-"));
  mkdirSync(join(dir, "client"), { recursive: true });
  const bundle = join(dir, "client", "kanban-browser.js");
  writeFileSync(bundle, marker);
  process.env.VIBEFLOW_KANBAN_DEV_BUNDLE = bundle;
  return dir;
}

describe("isKanbanDevMode", () => {
  it("is OFF by default — production stays the inlined bundle", () => {
    expect(isKanbanDevMode()).toBe(false);
    expect(isKanbanDevMode(false)).toBe(false);
    expect(isKanbanDevMode(undefined)).toBe(false);
  });

  it("is ON with the explicit --dev flag", () => {
    expect(isKanbanDevMode(true)).toBe(true);
  });

  it("is ON with VIBEFLOW_DEV=1 and OFF for any other value", () => {
    process.env.VIBEFLOW_DEV = "1";
    expect(isKanbanDevMode()).toBe(true);
    process.env.VIBEFLOW_DEV = "0";
    expect(isKanbanDevMode()).toBe(false);
    process.env.VIBEFLOW_DEV = "";
    expect(isKanbanDevMode()).toBe(false);
  });
});

describe("getKanbanHtml — production unchanged", () => {
  it("inlines the production bundle bytes with no dev asset reference", () => {
    const html = getKanbanHtml({ port: 3799 });
    expect(html).toContain(KANBAN_BUNDLE.slice(0, 120));
    expect(html).not.toContain(KANBAN_DEV_BUNDLE_ROUTE);
    expect(html).not.toContain(KANBAN_RELOAD_MESSAGE_TYPE);
    expect(html).not.toContain("__VIBEFLOW_DEV__");
  });

  it("stays in production when VIBEFLOW_DEV is unset even if a bundle is on disk", () => {
    const dir = seedDevBundle("/* dev-marker-should-not-leak */");
    try {
      const html = getKanbanHtml({ port: 3799 });
      expect(html).not.toContain(KANBAN_DEV_BUNDLE_ROUTE);
      expect(html).not.toContain("dev-marker-should-not-leak");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getKanbanHtml — dev serves the on-disk bundle", () => {
  it("references the dev asset route instead of inlining the bundle", () => {
    const dir = seedDevBundle("/* dev-marker-1 */");
    try {
      const html = getKanbanHtml({ port: 3799, dev: true });
      expect(html).toContain(`<script src=\"${KANBAN_DEV_BUNDLE_ROUTE}\"></script>`);
      // The production megastring must NOT be inlined in dev.
      expect(html).not.toContain(KANBAN_BUNDLE.slice(0, 120));
      expect(html).toContain("__VIBEFLOW_DEV__");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dev HTML contains the live-reload listener (signal, not just config)", () => {
    const dir = seedDevBundle("/* dev-marker-2 */");
    try {
      const html = getKanbanHtml({ port: 3799, dev: true });
      expect(html).toContain(KANBAN_RELOAD_MESSAGE_TYPE);
      expect(html).toContain("location.reload()");
      expect(html).toContain("WebSocket");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("VIBEFLOW_DEV=1 enables dev without the flag", () => {
    const dir = seedDevBundle("/* dev-marker-3 */");
    process.env.VIBEFLOW_DEV = "1";
    try {
      const html = getKanbanHtml({ port: 3799 });
      expect(html).toContain(`<script src=\"${KANBAN_DEV_BUNDLE_ROUTE}\"></script>`);
      expect(html).not.toContain(KANBAN_BUNDLE.slice(0, 120));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns loudly (no silent stale serve) when dev has no bundle on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-dev-empty-"));
    process.env.VIBEFLOW_KANBAN_DEV_BUNDLE = join(dir, "does-not-exist.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(existsSync(process.env.VIBEFLOW_KANBAN_DEV_BUNDLE)).toBe(false);
      const html = getKanbanHtml({ port: 3799, dev: true });
      // Loud refusal: the missing-bundle warning on stderr AND in the HTML.
      expect(errSpy).toHaveBeenCalledWith(KANBAN_DEV_BUNDLE_MISSING);
      expect(html).toContain("no built bundle found");
      expect(html).toContain(`<script src=\"${KANBAN_DEV_BUNDLE_ROUTE}\"></script>`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dev bundle resolution", () => {
  it("reads the on-disk bytes the dev route would serve", () => {
    const dir = seedDevBundle("/* on-disk-marker-abc */");
    try {
      expect(resolveKanbanDevBundlePath()).toBe(
        process.env.VIBEFLOW_KANBAN_DEV_BUNDLE,
      );
      expect(readKanbanDevBundle()?.bytes).toContain("on-disk-marker-abc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no bundle exists on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-dev-missing-"));
    process.env.VIBEFLOW_KANBAN_DEV_BUNDLE = join(dir, "nope.js");
    try {
      expect(readKanbanDevBundle()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reload trigger signal", () => {
  it("broadcasts exactly { type: \"kanban-reload\" } on rebuild", () => {
    const broadcast = vi.fn();
    notifyKanbanBundleRebuilt(broadcast);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      type: KANBAN_RELOAD_MESSAGE_TYPE,
    });
    expect(KANBAN_RELOAD_MESSAGE_TYPE).toBe("kanban-reload");
  });
});
