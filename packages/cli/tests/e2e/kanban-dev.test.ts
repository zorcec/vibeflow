/**
 * Kanban dev-mode live server (ticket 7e85c338): boots the REAL offline
 * server and proves the before/after over HTTP.
 *
 * - dev (`dev: true`): GET /kanban references the no-store dev asset instead
 *   of inlining the bundle; rewriting the on-disk bundle file changes what
 *   GET `KANBAN_DEV_BUNDLE_ROUTE` returns with NO server restart.
 * - prod (default): GET /kanban still inlines the production bytes; the dev
 *   asset route does not exist.
 * - loud refusal: dev with no bundle on disk answers the asset route with 500
 *   (fix included), never an empty/dated script.
 * - reload signal: a real bundle rewrite reaches a real websocket client as
 *   exactly `{ type: "kanban-reload" }`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { writeConfig } from "../../src/core/config.js";
import {
  KANBAN_DEV_BUNDLE_ROUTE,
  KANBAN_RELOAD_MESSAGE_TYPE,
} from "../../src/server/kanban-template.js";
import { KANBAN_BUNDLE } from "../../src/server/kanban-bundle.gen.js";
import { serveWithPort } from "../helpers/serve-with-port.js";
import type { ServeInstance } from "../../src/server/server.js";

process.env.VIBEFLOW_TELEMETRY = "0";

const BUNDLE_ENV = "VIBEFLOW_KANBAN_DEV_BUNDLE";
const DEV_ENV = "VIBEFLOW_DEV";

let savedBundleEnv: string | undefined;
let savedDevEnv: string | undefined;

beforeEach(() => {
  savedBundleEnv = process.env[BUNDLE_ENV];
  savedDevEnv = process.env[DEV_ENV];
  delete process.env[BUNDLE_ENV];
  delete process.env[DEV_ENV];
});

afterEach(() => {
  if (savedBundleEnv === undefined) delete process.env[BUNDLE_ENV];
  else process.env[BUNDLE_ENV] = savedBundleEnv;
  if (savedDevEnv === undefined) delete process.env[DEV_ENV];
  else process.env[DEV_ENV] = savedDevEnv;
});

/** Temp project dir + temp dev-bundle file seeded with `marker`. */
function seedTempProject(marker: string): { tempDir: string; bundle: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "kanban-dev-e2e-"));
  writeConfig(tempDir, { mode: "attach", port: 3700 });
  const bundleDir = join(tempDir, "dev-bundle");
  mkdirSync(bundleDir, { recursive: true });
  const bundle = join(bundleDir, "kanban-browser.js");
  writeFileSync(bundle, marker);
  process.env[BUNDLE_ENV] = bundle;
  return { tempDir, bundle };
}

async function bootDev(
  tempDir: string,
): Promise<ServeInstance> {
  return serveWithPort(undefined, {
    open: false,
    projectDir: tempDir,
    dev: true,
    // @internal test hooks — force OFFLINE mode so /kanban serves HTML
    _testToken: null,
    _testWorkspace: null,
  });
}

async function bootProd(
  tempDir: string,
): Promise<ServeInstance> {
  return serveWithPort(undefined, {
    open: false,
    projectDir: tempDir,
    // @internal test hooks — force OFFLINE mode so /kanban serves HTML
    _testToken: null,
    _testWorkspace: null,
  });
}

describe("kanban dev mode over HTTP", () => {
  let tempDir = "";
  let bundle = "";
  let instance: ServeInstance | null = null;

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  it("dev board references the dev asset; editing the bundle needs no restart", async () => {
    ({ tempDir, bundle } = seedTempProject("/* kanban-dev-marker-v1 */"));
    instance = await bootDev(tempDir);

    const board = await (await fetch(`${instance.url}/kanban`)).text();
    expect(board).toContain(`<script src=\"${KANBAN_DEV_BUNDLE_ROUTE}\"></script>`);
    expect(board).not.toContain(KANBAN_BUNDLE.slice(0, 120));
    expect(board).toContain(KANBAN_RELOAD_MESSAGE_TYPE);

    const assetV1 = await (await fetch(`${instance.url}${KANBAN_DEV_BUNDLE_ROUTE}`)).text();
    expect(assetV1).toContain("kanban-dev-marker-v1");

    // Edit the on-disk bundle (what `tsup --watch` does) — NO restart.
    writeFileSync(bundle, "/* kanban-dev-marker-v2 */");
    const resV2 = await fetch(`${instance.url}${KANBAN_DEV_BUNDLE_ROUTE}`);
    expect(resV2.headers.get("cache-control")).toBe("no-store");
    expect(await resV2.text()).toContain("kanban-dev-marker-v2");
  });

  it("a bundle rewrite reaches a websocket client as exactly { type: kanban-reload }", async () => {
    ({ tempDir, bundle } = seedTempProject("/* kanban-dev-marker-ws-v1 */"));
    instance = await bootDev(tempDir);

    const ws = new WebSocket(instance.url.replace("http", "ws"));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 10_000);
      ws.on("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    const reload = new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("reload signal timeout")), 15_000);
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg?.type === KANBAN_RELOAD_MESSAGE_TYPE) {
            clearTimeout(t);
            resolve(msg);
          }
        } catch {
          /* ignore non-JSON (e.g. task broadcasts carry other types) */
        }
      });
    });

    // What `tsup --watch` does on every kanban client edit.
    writeFileSync(bundle, "/* kanban-dev-marker-ws-v2 */");

    await expect(reload).resolves.toEqual({ type: "kanban-reload" });
    ws.close();
  });

  it("prod still serves the inlined bundle and exposes no dev asset", async () => {
    ({ tempDir } = seedTempProject("/* must-not-leak-into-prod */"));
    instance = await bootProd(tempDir);

    const board = await (await fetch(`${instance.url}/kanban`)).text();
    expect(board).toContain(KANBAN_BUNDLE.slice(0, 120));
    expect(board).not.toContain(KANBAN_DEV_BUNDLE_ROUTE);
    expect(board).not.toContain("must-not-leak-into-prod");

    const asset = await fetch(`${instance.url}${KANBAN_DEV_BUNDLE_ROUTE}`);
    expect(asset.status).toBe(404);
  });

  it("dev with no bundle on disk refuses loudly (500 + fix), never silently stale", async () => {
    ({ tempDir } = seedTempProject("/* placeholder */"));
    process.env[BUNDLE_ENV] = join(tempDir, "does-not-exist.js");
    instance = await bootDev(tempDir);

    const asset = await fetch(`${instance.url}${KANBAN_DEV_BUNDLE_ROUTE}`);
    expect(asset.status).toBe(500);
    const body = await asset.text();
    expect(body).toContain("tsup --watch");
    expect(body).toContain("Refusing to serve a stale/missing bundle");
  });
});
