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
