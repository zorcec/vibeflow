import { describe, it, expect } from "vitest";
import {
  localhostAltLine,
  localhostScriptTagAltLine,
} from "../../../src/server/server.js";

// Chalk may or may not emit ANSI codes depending on the TTY detection in the
// test worker; strip them so assertions work in both modes.
const plain = (s: string | null): string | null =>
  s === null ? null : s.replace(/\u001b\[[0-9;]*m/g, "");

describe("localhostAltLine (dual LAN + localhost banner rule)", () => {
  it("returns null when not bound to 0.0.0.0 (output unchanged)", () => {
    expect(localhostAltLine(null, "/kanban", 18)).toBeNull();
  });

  it("builds an aligned localhost continuation line", () => {
    expect(
      plain(localhostAltLine("http://localhost:3700", "/kanban", 18)),
    ).toBe(" ".repeat(18) + "http://localhost:3700/kanban");
  });

  it("supports a label prefix (e.g. 'or: ')", () => {
    expect(
      plain(localhostAltLine("http://localhost:3700", "/inject", 2, "or: ")),
    ).toBe("  or: http://localhost:3700/inject");
  });
});

describe("localhostScriptTagAltLine", () => {
  it("returns null when localUrl is null", () => {
    expect(localhostScriptTagAltLine(null, 5)).toBeNull();
  });

  it("renders the script tag with the localhost base URL", () => {
    expect(plain(localhostScriptTagAltLine("http://localhost:3700", 5))).toBe(
      '     or: <script src="http://localhost:3700/vibeflow-overlay.js" data-vibeflow-overlay></script>',
    );
  });
});

// Exercise the real banner with explicit auth state so the developer's HOME
// cannot change which snippet a test sees.
import { afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../../src/core/config.js";
import { serveWithPort } from "../../helpers/serve-with-port.js";

const workspace = { id: "board-123", name: "Board", url: "https://app.vibeflow.tools" };

describe("startup banner integration targets", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: "online with board", token: "test", workspace, online: true },
    { name: "logged in without board", token: "test", workspace: null, online: false },
    { name: "offline", token: null, workspace: null, online: false },
  ])("prints the correct integration guidance: $name", async (state) => {
    const dir = mkdtempSync(join(tmpdir(), "banner-auth-"));
    writeConfig(dir, { mode: "attach", port: 3700 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let instance: Awaited<ReturnType<typeof serveWithPort>> | undefined;
    try {
      instance = await serveWithPort(undefined, {
        open: false, projectDir: dir,
        _testToken: state.token, _testWorkspace: state.workspace,
      });
      const output = log.mock.calls.flat().join("\n");
      const inject = await (await fetch(`${instance.url}/inject`)).text();
      if (state.online) {
        expect(output).toContain('<script src="https://app.vibeflow.tools/api/overlay.js" data-vibeflow-overlay data-board-id="board-123"></script>');
        expect(output).not.toMatch(/<script src="http:\/\/localhost/);
        expect(output).toContain("Local proxy (works only while this CLI is running)");
        expect(inject).toContain("https://app.vibeflow.tools/api/overlay.js");
      } else if (state.token) {
        expect(output).toContain("No board selected — run vibeflow auth login");
        expect(output).not.toContain("<script");
        expect(inject).toContain("No board selected");
        expect(inject).not.toContain("<script");
      } else {
        expect(output).toContain(`<script src="${instance.url}/vibeflow-overlay.js" data-vibeflow-overlay></script>`);
        expect(inject).toContain("/vibeflow-overlay.js");
      }
    } finally {
      await instance?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
