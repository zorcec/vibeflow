import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("legacy attach command", () => {
  it("is no longer present under src/commands", () => {
    expect(existsSync(join(here, "../../src/commands/attach.ts"))).toBe(false);
    expect(existsSync(join(here, "../../src/commands/attach.js"))).toBe(false);
  });
});
