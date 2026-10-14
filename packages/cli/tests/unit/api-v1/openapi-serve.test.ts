/**
 * GET /api/openapi.json serves the checked-in spec verbatim.
 *
 * Byte-identity proof: the served body must equal docs/api/openapi.json
 * byte-for-byte (the embed is generated, not hand-maintained — the
 * drift-guards suite pins the generator side).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeConfig } from "../../../src/core/config.js";
import { OPENAPI_SHA256 } from "../../../src/server/openapi.gen.js";
import { serveWithPort } from "../../helpers/serve-with-port.js";
import type { ServeInstance } from "../../../src/server/server.js";

process.env.VIBEFLOW_TELEMETRY = "0";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");

describe("GET /api/openapi.json", () => {
  let tempDir: string;
  let instance: ServeInstance;
  let baseUrl: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-openapi-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir: tempDir,
      _testToken: null,
      _testWorkspace: null,
    });
    baseUrl = instance.url;
  }, 30000);

  afterAll(async () => {
    await instance?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("is byte-identical to docs/api/openapi.json", async () => {
    const expected = readFileSync(
      join(REPO_ROOT, "docs", "api", "openapi.json"),
      "utf-8",
    );
    const res = await fetch(`${baseUrl}/api/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.text();
    expect(body).toBe(expected);
    expect(createHash("sha256").update(body).digest("hex")).toBe(OPENAPI_SHA256);
  });
});
