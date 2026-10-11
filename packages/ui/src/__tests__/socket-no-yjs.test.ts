import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R7 guard: the shared realtime surface (`socket.ts` — also used by the
 * offline CLI kanban with `enabled: false`) must never import Yjs. The CRDT
 * layer is web-only; the shared module takes an injected transport precisely
 * so the CLI bundle stays free of realtime code. This test pins that.
 */
describe("shared socket surface stays Yjs-free", () => {
  const source = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "socket.ts",
    ),
    "utf8",
  );

  it("has no static or dynamic yjs / y-protocols import", () => {
    expect(source).not.toMatch(/from\s+["']yjs["']/);
    expect(source).not.toMatch(/from\s+["']y-protocols/);
    expect(source).not.toMatch(/require\(\s*["']yjs["']/);
    expect(source).not.toMatch(/import\(\s*["']yjs["']/);
  });

  it("only imports react and relative modules", () => {
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (m) => m[1]!,
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec === "react" || spec.startsWith(".")).toBe(true);
    }
  });
});
