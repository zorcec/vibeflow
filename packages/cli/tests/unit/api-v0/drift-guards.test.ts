/**
 * Anti-drift guards, Phase 1 wiring (plan §6.4).
 *
 * Guard #1 — registry ⇄ spec ⇄ handler agreement: a v0 route must appear in
 * the generated registry, in the OpenAPI document, AND as a real handler; a
 * route present in any one but not the others fails. Both directions are
 * asserted, and the comparison helpers are unit-tested against synthetic
 * drift so the guard is proven non-vacuous even without touching real files
 * (the manual break-and-revert demonstration is reported separately).
 *
 * Guard #2 — no-second-implementation: no /api/cli/* registration may
 * appear anywhere, and every /api/v0/* registration must live in the
 * single alias module (src/server/v0.ts), which statically imports no
 * store module — the alias delegates, it does not re-implement. No
 * bearer-accepting handler may exist outside /api/v0 (which itself reads
 * no Authorization header in P1) — today that means the only
 * Authorization-reader is the loopback MCP auth, allowlisted by name.
 *
 * Coverage guard (§6.3): every registry route has ≥1 manifest row, and every
 * manifest row names a registry route — the manifest cannot silently shrink.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, "..", "..", "..");
const REPO_ROOT = join(CLI_ROOT, "..", "..");
const SRC_ROOT = join(CLI_ROOT, "src");

interface LocalRef {
  method: string;
  path: string;
}
interface RegistryOp {
  id: string;
  method: string;
  v0Path: string;
  local: LocalRef | null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadContract(): {
  operations: RegistryOp[];
  localOnly: LocalRef[];
  nonApiCarveOuts: { prefix: string }[];
} {
  return readJson(join(REPO_ROOT, "docs", "api", "v0-contract.json")) as {
    operations: RegistryOp[];
    localOnly: LocalRef[];
    nonApiCarveOuts: { prefix: string }[];
  };
}

function loadSpecOps(): { method: string; path: string }[] {
  const doc = readJson(join(REPO_ROOT, "docs", "api", "openapi.json")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const ops: { method: string; path: string }[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) {
      ops.push({ method: method.toUpperCase(), path });
    }
  }
  return ops;
}

/**
 * Scan Express registrations. Counts method-specific mounts with a string
 * literal path starting in /api (the contract surface). `app.all` expands
 * to the methods the MCP transport actually serves. `app.use` (tRPC mount,
 * the online-mode 503 block, MCP middleware) registers no contract route
 * and is intentionally ignored — see the carve-out list instead.
 */
export function scanApiHandlers(
  sources: { file: string; text: string }[],
): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  const re = /app\.(get|post|patch|put|delete|all)\s*\(\s*["']([^"']+)["']/g;
  for (const { text } of sources) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const [, verb, path] = m;
      if (!path.startsWith("/api/")) continue;
      if (verb === "all") {
        for (const method of ["GET", "POST", "DELETE"]) {
          found.push({ method, path });
        }
      } else {
        found.push({ method: verb.toUpperCase(), path });
      }
    }
  }
  const seen = new Set<string>();
  return found.filter((h) => {
    const key = `${h.method} ${h.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loadScannedHandlers(): { method: string; path: string }[] {
  return scanApiHandlers([
    {
      file: "server.ts",
      text: readFileSync(join(SRC_ROOT, "server", "server.ts"), "utf-8"),
    },
    {
      file: "server/v0.ts",
      text: readFileSync(join(SRC_ROOT, "server", "v0.ts"), "utf-8"),
    },
    {
      file: "server/docs.ts",
      text: readFileSync(join(SRC_ROOT, "server", "docs.ts"), "utf-8"),
    },
    {
      file: "mcp/http.ts",
      text: readFileSync(join(SRC_ROOT, "mcp", "http.ts"), "utf-8"),
    },
  ]);
}

/** Set difference helper with a readable diff message. */
export function diffSets(
  have: string[],
  want: string[],
): { missing: string[]; extra: string[] } {
  const haveSet = new Set(have);
  const wantSet = new Set(want);
  return {
    missing: want.filter((x) => !haveSet.has(x)),
    extra: have.filter((x) => !wantSet.has(x)),
  };
}

const opKey = (o: { method: string; path: string }) => `${o.method} ${o.path}`;
const v0Key = (o: RegistryOp) => `${o.method} ${o.v0Path}`;

describe("guard #1: registry ⇄ spec ⇄ handler agreement", () => {
  it("registry v0 set equals the OpenAPI paths set, both directions", () => {
    const contract = loadContract();
    const specKeys = loadSpecOps().map(opKey).sort();
    const registryKeys = contract.operations.map(v0Key).sort();
    const { missing, extra } = diffSets(specKeys, registryKeys);
    expect(
      { missing, extra },
      `spec ⇄ registry drift — missing from spec: ${missing.join(", ")}; ` +
        `in registry but not spec: ${extra.join(", ")}`,
    ).toEqual({ missing: [], extra: [] });
  });

  it("every registry op with a local handler resolves to a real scanned handler", () => {
    const contract = loadContract();
    const handlers = new Set(loadScannedHandlers().map(opKey));
    const dangling = contract.operations
      .filter((op) => op.local !== null)
      .filter((op) => !handlers.has(opKey(op.local as LocalRef)))
      .map((op) => `${op.id}: ${opKey(op.local as LocalRef)}`);
    expect(
      dangling,
      `registry entries with no handler: ${dangling.join("; ")}`,
    ).toEqual([]);
  });

  it("every scanned /api handler is classified — an unregistered route fails", () => {
    const contract = loadContract();
    const classified = new Set<string>();
    for (const op of contract.operations) {
      if (op.local) classified.add(opKey(op.local));
    }
    for (const r of contract.localOnly) classified.add(opKey(r));
    const carveOuts = contract.nonApiCarveOuts.map((c) => c.prefix);
    const unclassified = loadScannedHandlers().filter((h) => {
      if (classified.has(opKey(h))) return false;
      // /api/v0/* handlers are classified by the dedicated template
      // test below (registry {param} vs express :param), not here.
      if (h.path === "/api/v0" || h.path.startsWith("/api/v0/")) {
        return false;
      }
      // Infra routes (openapi.json, /api/docs) are carved out by prefix.
      if (carveOuts.some((p) => h.path === p || h.path.startsWith(p + "/"))) {
        return false;
      }
      return true;
    });
    expect(
      unclassified.map(opKey),
      `UNREGISTERED route(s) — add to the contract or remove: ${unclassified.map(opKey).join(", ")}`,
    ).toEqual([]);
  });

  it("the comparison itself is non-vacuous: synthetic drift is reported", () => {
    const { missing, extra } = diffSets(
      ["GET /api/v0/tasks", "GET /api/v0/tasks/{id}"],
      ["GET /api/v0/tasks", "POST /api/v0/tasks"],
    );
    expect(missing).toEqual(["POST /api/v0/tasks"]);
    expect(extra).toEqual(["GET /api/v0/tasks/{id}"]);
    expect(diffSets(["A"], ["A"])).toEqual({ missing: [], extra: [] });
  });

  it("the handler scanner sees the known surface (spot check, not a copy)", () => {
    const keys = new Set(loadScannedHandlers().map(opKey));
    // A mapped read, a local-only route, the viewer route, and the MCP mount.
    expect(keys.has("GET /api/tasks")).toBe(true);
    expect(keys.has("POST /api/push")).toBe(true);
    expect(keys.has("GET /api/openapi.json")).toBe(true);
    expect(keys.has("POST /api/mcp")).toBe(true);
    // Sanity floor: the surface the ticket names (prevents a silent scan break).
    expect(keys.size).toBeGreaterThan(25);
  });
});

/**
 * Template agreement: registry v0 paths use {param}, express routes use
 * :param. Equal method + equal segments up to that rename = agreement.
 */
export function v0PathsAgree(registryPath: string, expressPath: string): boolean {
  const norm = (s: string): string =>
    s.replace(/\{(\w+)\}/g, ":$1");
  return norm(registryPath) === expressPath;
}

describe("guard #1: v0 alias ⇄ registry agreement (one handler per resource)", () => {
  it("the template comparison itself is non-vacuous", () => {
    expect(v0PathsAgree("/api/v0/tasks/{id}", "/api/v0/tasks/:id")).toBe(true);
    expect(v0PathsAgree("/api/v0/tasks", "/api/v0/tasks")).toBe(true);
    expect(v0PathsAgree("/api/v0/tasks/{id}", "/api/v0/tasks/:other")).toBe(
      false,
    );
    expect(v0PathsAgree("/api/v0/tasks/{id}", "/api/v0/tasks")).toBe(false);
    expect(v0PathsAgree("/api/v0/tasks", "/api/v0/users")).toBe(false);
  });

  it("every scanned /api/v0 handler matches exactly one registry op", async () => {
    const { V0_READ_IDS } = await import("../../../src/server/v0.js");
    const contract = loadContract();
    const registry = contract.operations;
    const v0Handlers = loadScannedHandlers().filter((h) =>
      h.path.startsWith("/api/v0/"),
    );
    expect(v0Handlers.length).toBeGreaterThan(0);
    const mounted = new Set<string>(V0_READ_IDS as readonly string[]);
    for (const h of v0Handlers) {
      const matches = registry.filter(
        (op) => op.method === h.method && v0PathsAgree(op.v0Path, h.path),
      );
      expect(
        matches.map((m) => m.id),
        `${opKey(h)} must match exactly one registry op`,
      ).toHaveLength(1);
      expect(
        mounted.has(matches[0].id),
        `${opKey(h)} matches ${matches[0].id}, which is not a mounted P1 read`,
      ).toBe(true);
    }
  });

  it("every mounted P1 read op has exactly one scanned handler", async () => {
    const { V0_READ_IDS } = await import("../../../src/server/v0.js");
    const contract = loadContract();
    const byId = new Map(contract.operations.map((op) => [op.id, op]));
    const v0Handlers = loadScannedHandlers().filter((h) =>
      h.path.startsWith("/api/v0/"),
    );
    for (const id of V0_READ_IDS as readonly string[]) {
      const op = byId.get(id);
      expect(op, `mounted read ${id} must be a registry op`).toBeDefined();
      const handlers = v0Handlers.filter(
        (h) =>
          h.method === op?.method &&
          v0PathsAgree(op?.v0Path as string, h.path),
      );
      expect(
        handlers.map(opKey),
        `P1 read ${id} must have exactly one handler (one handler per resource)`,
      ).toHaveLength(1);
    }
  });
});

describe("guard #1 support: generated artifacts are fresh and canonical", () => {
  it("gen:api --check passes (checked-in artifacts equal generated output)", () => {
    const out = execFileSync(
      process.execPath,
      [join(REPO_ROOT, "packages", "api-core", "scripts", "gen-api-artifacts.mjs"), "--check"],
      { encoding: "utf-8" },
    );
    expect(out).toContain("fresh");
  });

  it("openapi.yaml is byte-identical to the emitter output (hand-edit protection)", async () => {
    const gen = (await import(
      "../../../../api-core/scripts/gen-api-artifacts.mjs"
    )) as typeof import("../../../../api-core/scripts/gen-api-artifacts.mjs");
    const contract = loadContract() as unknown as Parameters<
      typeof gen.buildOpenApiDocument
    >[0];
    const doc = gen.buildOpenApiDocument(contract);
    expect(gen.emitYaml(doc)).toBe(
      readFileSync(join(REPO_ROOT, "docs", "api", "openapi.yaml"), "utf-8"),
    );
    expect(gen.emitOpenApiJson(doc)).toBe(
      readFileSync(join(REPO_ROOT, "docs", "api", "openapi.json"), "utf-8"),
    );
  });

  it("openapi.json is structurally valid OpenAPI 3.1 with resolvable refs", () => {
    const doc = readJson(join(REPO_ROOT, "docs", "api", "openapi.json")) as {
      openapi: string;
      info: unknown;
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    expect(doc.info).toBeDefined();
    const contract = loadContract();
    const opCount = Object.values(doc.paths).reduce(
      (n, item) => n + Object.keys(item).length,
      0,
    );
    expect(opCount).toBe(contract.operations.length);
    const refs = new Set<string>();
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const v of node) collect(v);
      } else if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "$ref" && typeof v === "string") refs.add(v);
          else collect(v);
        }
      }
    };
    collect(doc);
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      const match = ref.match(/^#\/components\/schemas\/([\w-]+)$/);
      expect(match, `non-local ref ${ref}`).not.toBeNull();
      expect(
        doc.components.schemas[match?.[1] as string] !== undefined,
        `unresolvable ref ${ref}`,
      ).toBe(true);
    }
    // v0 create ops answer 201 Created (create-task precedent, add-link
    // included — POST .../links creates a link and the cloud answers 201);
    // every other op answers 200. The success code is asserted exactly — a
    // create declaring 200 (or a read declaring 201) fails, so the spec
    // cannot drift back without failing loudly.
    const created = new Set([
      "create-task",
      "create-token",
      "create-board",
      "add-link",
    ]);
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        expect(op.operationId, `${method} ${path}`).toBeTruthy();
        const want = created.has(op.operationId as string) ? "201" : "200";
        const other = want === "201" ? "200" : "201";
        expect(op.responses?.[want], `${method} ${path}`).toBeDefined();
        expect(
          op.responses?.[other],
          `${method} ${path}: must declare exactly ${want}, not both`,
        ).toBeUndefined();
      }
    }
  });
});

describe("coverage guard: every registry route appears in the manifest", () => {
  it("manifest covers every v0 op and names no unknown op, both directions", () => {
    const contract = loadContract();
    const manifest = readJson(
      join(REPO_ROOT, "docs", "api", "conformance-manifest.json"),
    ) as { entries: { id: string }[] };
    const registryIds = contract.operations.map((o) => o.id).sort();
    const manifestIds = manifest.entries.map((e) => e.id).sort();
    const { missing, extra } = diffSets(manifestIds, registryIds);
    expect(
      { missing, extra },
      `manifest drift — ops without a manifest row: ${missing.join(", ")}; ` +
        `manifest rows for unknown ops: ${extra.join(", ")}`,
    ).toEqual({ missing: [], extra: [] });
    expect(manifestIds.length).toBe(registryIds.length);
  });

  it("every manifest entry declares its surfaces; cloud skips name their reason", () => {
    const manifest = readJson(
      join(REPO_ROOT, "docs", "api", "conformance-manifest.json"),
    ) as {
      entries: { id: string; surfaces?: unknown; cloudSkipReason?: unknown }[];
    };
    const badSurfaces: string[] = [];
    const reasonless: string[] = [];
    for (const e of manifest.entries) {
      const surfaces = e.surfaces;
      if (
        !Array.isArray(surfaces) ||
        surfaces.length > 2 ||
        !surfaces.every((s) => s === "local" || s === "cloud")
      ) {
        badSurfaces.push(e.id);
        continue;
      }
      if (
        !surfaces.includes("cloud") &&
        (typeof e.cloudSkipReason !== "string" || e.cloudSkipReason.length === 0)
      ) {
        reasonless.push(e.id);
      }
    }
    // The cloud run takes its skip/run decision from `surfaces` and reports
    // every other entry skipped with `cloudSkipReason` — a malformed row or
    // a reasonless skip would make the cloud report lie by omission.
    expect(badSurfaces, `entries with malformed surfaces: ${badSurfaces.join(", ")}`).toEqual([]);
    expect(reasonless, `cloud-skipped entries with no cloudSkipReason: ${reasonless.join(", ")}`).toEqual([]);
    const cloudIds = manifest.entries
      .filter((e) => (e.surfaces as string[]).includes("cloud"))
      .map((e) => e.id)
      .sort();
    expect(
      cloudIds.length,
      `cloud-surfaced ops (${cloudIds.length}): ${cloudIds.join(", ")}`,
    ).toBeGreaterThan(0);
  });
});

describe("guard #2: no-second-implementation + bearer-surface invariant", () => {
  it("no /api/cli/* route is registered; /api/v0/* routes live only in server/v0.ts", () => {
    // Registration-scoped, deliberately: outbound client fetch URLs to the
    // cloud legacy surface (saas/client.ts, auth/login.ts, push proxy) are
    // the CLI *consuming* the cloud — they move to /api/v0 with the client
    // at cutover (Phase 3) and are out of scope here. What must never exist
    // is a SERVED route under /api/cli/*, and /api/v0/* routes may only be
    // served by the single alias module (server/v0.ts) — never a second
    // implementation scattered across the surface.
    const cliOffenders: string[] = [];
    const v0Offenders: string[] = [];
    const cliRe =
      /app\.(get|post|patch|put|delete|all|use)\s*\([^)]*["']\/api\/cli(\/|"|')/;
    const v0Re =
      /app\.(get|post|patch|put|delete|all|use)\s*\([^)]*["']\/api\/v0(\/|"|')/;
    const v0Home = join(SRC_ROOT, "server", "v0.ts");
    const walk = (dir: string): void => {
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts") || full.endsWith(".gen.ts")) continue;
        const text = readFileSync(full, "utf-8");
        if (cliRe.test(text)) {
          cliOffenders.push(full);
        }
        if (v0Re.test(text) && full !== v0Home) {
          v0Offenders.push(full);
        }
      }
    };
    walk(SRC_ROOT);
    expect(cliOffenders, `legacy route registration in: ${cliOffenders.join(", ")}`).toEqual([]);
    expect(v0Offenders, `/api/v0 registration outside server/v0.ts in: ${v0Offenders.join(", ")}`).toEqual([]);
    // Sanity: the alias surface is actually seen (prevents a silent scan break).
    const v0Source = readFileSync(v0Home, "utf-8");
    const v0Regs = v0Source.match(/app\.(get|use)\s*\(\s*["']\/api\/v0/g) ?? [];
    expect(v0Regs.length, "server/v0.ts must hold the v0 registrations").toBeGreaterThanOrEqual(9);
  });
});

/**
 * The alias delegates — it must not re-parse bodies or reach the store
 * (ticket anti-drift rule). v0.ts may import express types and api-core
 * only; any relative import is a second implementation taking shape.
 */
export function relativeImports(source: string): string[] {
  return [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
}

describe("guard #2 support: the v0 alias reaches no store", () => {
  it("the import check itself is non-vacuous", () => {
    expect(relativeImports(`import x from "../core/tasks.js";`)).toEqual([
      "../core/tasks.js",
    ]);
    expect(
      relativeImports(
        `import type { Express } from "express";\nimport { x } from "@vibeflow-tools/api-core";`,
      ),
    ).toEqual([]);
  });

  it("server/v0.ts holds no relative import (no body parsing, no store)", () => {
    const source = readFileSync(
      join(SRC_ROOT, "server", "v0.ts"),
      "utf-8",
    );
    expect(
      relativeImports(source),
      `server/v0.ts must not import sibling modules — it delegates: ${relativeImports(source).join(", ")}`,
    ).toEqual([]);
  });
});

describe("guard #2 support: bearer-surface invariant", () => {
  it("no bearer-accepting handler outside the allowlist (bearer only under /api/v0/*)", () => {
    // Inbound Authorization readers. Outbound `Authorization: Bearer ${token}`
    // fetch headers (push proxy) do not match these patterns (lowercase
    // `.headers.authorization` member reads), by construction.
    const readers: string[] = [];
    const walk = (dir: string): void => {
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts") || full.endsWith(".gen.ts")) continue;
        const text = readFileSync(full, "utf-8");
        if (
          /\.headers\.authorization\b/.test(text) ||
          /headers\[["']authorization["']\]/.test(text)
        ) {
          readers.push(full);
        }
      }
    };
    walk(SRC_ROOT);
    // Allowlist with reasons (plan §4.4, P0 wiring):
    // - src/mcp/auth.ts: loopback MCP auth (local trust / stored-token check),
    //   grandfathered until the v0 mount + PATs land (P1/P2).
    const allowlist = [join(SRC_ROOT, "mcp", "auth.ts")];
    const unexpected = readers.filter((f) => !allowlist.includes(f));
    expect(
      unexpected,
      `new bearer-accepting handler(s) — bearer tokens are accepted only under /api/v0/*: ${unexpected.join(", ")}`,
    ).toEqual([]);
    // The allowlist entry must actually exist and read the header (guard sanity).
    expect(readers).toContain(allowlist[0]);
    expect(existsSync(allowlist[0])).toBe(true);
  });
});
