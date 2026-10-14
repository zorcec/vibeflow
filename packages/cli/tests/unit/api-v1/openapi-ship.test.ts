/**
 * openapi-ship guard (source side), ticket ee0996b1.
 *
 * The shipped spec must be GENERATED from docs/api/v1-contract.json via
 * packages/api-core/scripts/gen-api-artifacts.mjs — never hand-maintained.
 * This pins the source half of that chain: the bundled embed
 * (src/server/openapi.gen.ts, printed by `vibeflow openapi`) is byte-identical
 * to the checked-in docs/api/openapi.json + openapi.yaml twins. The e2e twin
 * (tests/e2e/openapi-ship.test.ts) pins the other half: dist/openapi.* and the
 * spawned CLI stdout.
 *
 * Non-vacuity is proven synthetically below (a single flipped byte must NOT
 * compare equal), so a skipped generator or a stale copy fails loudly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { printOpenApi } from "../../../src/commands/openapi.js";
import {
  OPENAPI_JSON,
  OPENAPI_YAML,
} from "../../../src/server/openapi.gen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");

function readDoc(name: string): string {
  return readFileSync(join(REPO_ROOT, "docs", "api", name), "utf-8");
}

describe("openapi-ship (source): bundled embed equals the checked-in spec", () => {
  it("OPENAPI_JSON is byte-identical to docs/api/openapi.json", () => {
    expect(OPENAPI_JSON).toBe(readDoc("openapi.json"));
  });

  it("OPENAPI_YAML is byte-identical to docs/api/openapi.yaml", () => {
    expect(OPENAPI_YAML).toBe(readDoc("openapi.yaml"));
  });

  it("the embedded JSON parses and matches the embedded YAML document", async () => {
    const parsed = JSON.parse(OPENAPI_JSON) as { openapi: string };
    expect(parsed.openapi).toMatch(/^3\.1\.\d+$/);
    const gen = (await import(
      "../../../../api-core/scripts/gen-api-artifacts.mjs"
    )) as typeof import("../../../../api-core/scripts/gen-api-artifacts.mjs");
    expect(gen.emitYaml(parsed)).toBe(OPENAPI_YAML);
  });
});

describe("openapi-ship (source): printOpenApi writes exactly the spec", () => {
  let write: ReturnType<typeof vi.spyOn>;
  let chunks: string[];

  beforeEach(() => {
    chunks = [];
    write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
  });

  afterEach(() => {
    write.mockRestore();
  });

  it("prints the JSON spec by default", () => {
    printOpenApi({});
    expect(chunks.join("")).toBe(readDoc("openapi.json"));
  });

  it("prints the YAML twin with { yaml: true }", () => {
    printOpenApi({ yaml: true });
    expect(chunks.join("")).toBe(readDoc("openapi.yaml"));
  });

  it("is non-vacuous: a single flipped byte does not compare equal", () => {
    printOpenApi({});
    const printed = chunks.join("");
    const flipped =
      printed.slice(0, 10) +
      (printed[10] === "X" ? "Y" : "X") +
      printed.slice(11);
    expect(printed).toBe(readDoc("openapi.json"));
    expect(flipped).not.toBe(readDoc("openapi.json"));
    chunks.length = 0;
    printOpenApi({ yaml: true });
    const printedYaml = chunks.join("");
    expect(printedYaml).toBe(readDoc("openapi.yaml"));
    expect(`corrupted${printedYaml}`).not.toBe(readDoc("openapi.yaml"));
  });

  it("exits quietly on EPIPE (closed pipe) instead of throwing", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as typeof process.exit);
    try {
      printOpenApi({});
      const callback = write.mock.calls[0][1] as (err?: Error) => void;
      expect(typeof callback).toBe("function");
      // No error: no exit.
      callback();
      expect(exit).not.toHaveBeenCalled();
      // Closed pipe: quiet exit 0, no traceback.
      const epipe = new Error("write EPIPE") as NodeJS.ErrnoException;
      epipe.code = "EPIPE";
      expect(() => callback(epipe)).toThrow("process.exit called");
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });
});
