/**
 * Anti-drift guards, Phase 0 wiring (plan §6.4).
 *
 * Guard #1 — registry ⇄ spec ⇄ handler agreement: a v1 route must appear in
 * the generated registry, in the OpenAPI document, AND as a real handler; a
 * route present in any one but not the others fails. Both directions are
 * asserted, and the comparison helpers are unit-tested against synthetic
 * drift so the guard is proven non-vacuous even without touching real files
 * (the manual break-and-revert demonstration is reported separately).
 *
 * Guard #2 — legacy-may-not-re-implement: no /api/cli/* or /api/v1/*
 * registration may appear in the CLI surface (the legacy cloud surface is
 * removed at cutover, not aliased), and no bearer-accepting handler may
 * exist outside the (future) /api/v1 mount — today that means the only
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
  v1Path: string;
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
  return readJson(join(REPO_ROOT, "docs", "api", "v1-contract.json")) as {
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
const v1Key = (o: RegistryOp) => `${o.method} ${o.v1Path}`;

describe("guard #1: registry ⇄ spec ⇄ handler agreement", () => {
  it("registry v1 set equals the OpenAPI paths set, both directions", () => {
    const contract = loadContract();
    const specKeys = loadSpecOps().map(opKey).sort();
    const registryKeys = contract.operations.map(v1Key).sort();
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
      // The contract viewer route is infra, carved out by exact prefix.
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
      ["GET /api/v1/tasks", "GET /api/v1/tasks/{id}"],
      ["GET /api/v1/tasks", "POST /api/v1/tasks"],
    );
    expect(missing).toEqual(["POST /api/v1/tasks"]);
    expect(extra).toEqual(["GET /api/v1/tasks/{id}"]);
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
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        expect(op.operationId, `${method} ${path}`).toBeTruthy();
        expect(op.responses?.["200"], `${method} ${path}`).toBeDefined();
      }
    }
  });
});

describe("coverage guard: every registry route appears in the manifest", () => {
  it("manifest covers every v1 op and names no unknown op, both directions", () => {
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
});

describe("guard #2: legacy-may-not-re-implement + bearer-surface invariant", () => {
  it("no /api/cli/* or /api/v1/* ROUTE is registered in the CLI surface", () => {
    // Registration-scoped, deliberately: outbound client fetch URLs to the
    // cloud legacy surface (saas/client.ts, auth/login.ts, push proxy) are
    // the CLI *consuming* the cloud — they move to /api/v1 with the client
    // at cutover (Phase 3) and are out of scope here. What must never exist
    // is a served route under those prefixes (an alias/shim/compat mount).
    const offenders: string[] = [];
    const regRe =
      /app\.(get|post|patch|put|delete|all|use)\s*\([^)]*["']\/api\/(cli|v1)(\/|"|')/;
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
        if (regRe.test(text)) {
          offenders.push(full);
        }
      }
    };
    walk(SRC_ROOT);
    expect(offenders, `legacy/alias route registration in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no bearer-accepting handler outside the allowlist (bearer only under /api/v1/*)", () => {
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
    //   grandfathered until the v1 mount + PATs land (P1/P2).
    const allowlist = [join(SRC_ROOT, "mcp", "auth.ts")];
    const unexpected = readers.filter((f) => !allowlist.includes(f));
    expect(
      unexpected,
      `new bearer-accepting handler(s) — bearer tokens are accepted only under /api/v1/*: ${unexpected.join(", ")}`,
    ).toEqual([]);
    // The allowlist entry must actually exist and read the header (guard sanity).
    expect(readers).toContain(allowlist[0]);
    expect(existsSync(allowlist[0])).toBe(true);
  });
});
