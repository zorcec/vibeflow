/**
 * openapi-ship guard (shipped side), ticket ee0996b1.
 *
 * Pins what the unit twin (tests/unit/api-v0/openapi-ship.test.ts) cannot:
 * the SHIPPED artifacts. `dist/openapi.json` + `dist/openapi.yaml` (emitted
 * at build time by gen-api-artifacts.mjs, carried in package.json `files`
 * with `./openapi.json` / `./openapi.yaml` exports leaves) and the spawned
 * `vibeflow openapi [--yaml]` stdout must ALL be byte-identical to the
 * checked-in docs/api/openapi.json + openapi.yaml twins.
 *
 * Non-vacuity: dist is read from disk (a missing/stale copy throws or
 * mismatches — the failure message says to rebuild), stdout comes from a
 * real spawned CLI, and the final case proves a corrupted payload does NOT
 * compare equal. If the generator is skipped or the copy goes stale, this
 * fails. Build first: pnpm --filter @vibeflow-tools/cli run build.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCli } from "./mcp-helpers.js";

process.env.VIBEFLOW_TELEMETRY = "0";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(join(HERE, "..", "..", "..", ".."));
// ADR-adjacent rule: never resolve build artifacts from process.cwd() — the
// suite root (packages/cli) and the invoker cwd differ whenever this file is
// run by absolute path from the repo root or /tmp, so cwd-based resolution
// lies depending on where you stand. Anchor at the module location instead.
const PKG_ROOT = resolve(join(HERE, "..", ".."));
const DIST_DIR = join(PKG_ROOT, "dist");

function readDoc(name: string): string {
  return readFileSync(join(REPO_ROOT, "docs", "api", name), "utf-8");
}

function readDist(name: string): string {
  const path = join(DIST_DIR, name);
  expect(
    existsSync(path),
    `missing ${path} — the spec ships at build time, run: pnpm --filter @vibeflow-tools/cli run build`,
  ).toBe(true);
  return readFileSync(path, "utf-8");
}

describe("openapi-ship (dist): shipped spec files equal the checked-in spec", () => {
  it("regression: DIST_DIR is anchored at the package root, not process.cwd()", () => {
    expect(DIST_DIR).toBe(join(PKG_ROOT, "dist"));
    expect(PKG_ROOT).toBe(resolve(join(HERE, "..", "..")));
  });

  it("regression: a missing artifact fails loudly naming the absolute path looked for", () => {
    const name = "__regression_probe__.json";
    const abs = join(DIST_DIR, name);
    expect(resolve(abs)).toBe(abs);
    expect(existsSync(abs)).toBe(false);
    expect(() => readDist(name)).toThrow(abs);
  });

  it("dist/openapi.json is byte-identical to docs/api/openapi.json", () => {
    expect(readDist("openapi.json")).toBe(readDoc("openapi.json"));
  });

  it("dist/openapi.yaml is byte-identical to docs/api/openapi.yaml", () => {
    expect(readDist("openapi.yaml")).toBe(readDoc("openapi.yaml"));
  });
});

describe("openapi-ship (dist): `vibeflow openapi` prints the shipped spec", () => {
  let cwd: string;
  let home: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "openapi-ship-cwd-"));
    home = mkdtempSync(join(tmpdir(), "openapi-ship-home-"));
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("`vibeflow openapi` stdout is byte-identical to docs/api/openapi.json", async () => {
    const res = await runCli(["openapi"], { cwd, home });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(readDoc("openapi.json"));
  });

  it("`vibeflow openapi --yaml` stdout is byte-identical to docs/api/openapi.yaml", async () => {
    const res = await runCli(["openapi", "--yaml"], { cwd, home });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(readDoc("openapi.yaml"));
  });

  it("is non-vacuous: a corrupted payload does not compare equal", async () => {
    const res = await runCli(["openapi"], { cwd, home });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(readDoc("openapi.json"));
    expect(`corrupted${res.stdout}`).not.toBe(readDoc("openapi.json"));
    const yaml = await runCli(["openapi", "--yaml"], { cwd, home });
    expect(yaml.code).toBe(0);
    expect(yaml.stdout).toBe(readDoc("openapi.yaml"));
    expect(yaml.stdout).not.toBe(readDoc("openapi.json"));
  });
});
