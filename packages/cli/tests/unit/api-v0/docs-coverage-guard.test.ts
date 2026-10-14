/**
 * Docs coverage guard (plan §6.4, Phase 5 polish).
 *
 * The Phase 1 viewer (GET /api/docs, Swagger UI over GET /api/openapi.json)
 * is the ONE docs stack — this guard keeps it from silently rotting by
 * asserting, for EVERY registry route, that the served spec carries:
 * - a per-endpoint example (`x-vibeflow-example-request` + standard
 *   `examples` on the JSON request/response media types), sourced from
 *   docs/api/v0-examples.json, and
 * - a deep-linkable identity (`operationId` + ≥1 tag, so Swagger UI's
 *   `deepLinking` exposes `#/<tag>/<operationId>` for the route).
 *
 * A registry route missing from the examples file, an example for an
 * unknown route, or an emitted operation without its example all fail.
 * Non-vacuity is proven on synthetic drift (no real files touched).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, "..", "..", "..");
const REPO_ROOT = join(CLI_ROOT, "..", "..");
const SRC_ROOT = join(CLI_ROOT, "src");

interface RegistryOp {
  id: string;
  method: string;
  v0Path: string;
}

function loadRegistryIds(): RegistryOp[] {
  const contract = JSON.parse(
    readFileSync(join(REPO_ROOT, "docs", "api", "v0-contract.json"), "utf-8"),
  ) as { operations: RegistryOp[] };
  return contract.operations;
}

function loadExamples(): Record<string, unknown> {
  const doc = JSON.parse(
    readFileSync(join(REPO_ROOT, "docs", "api", "v0-examples.json"), "utf-8"),
  ) as { examples: Record<string, unknown> };
  return doc.examples;
}

interface SpecOperation {
  operationId?: string;
  tags?: string[];
  parameters?: { in: string; name: string }[];
  requestBody?: { content?: Record<string, { examples?: unknown }> };
  responses?: Record<string, { content?: Record<string, { examples?: unknown }> }>;
  "x-vibeflow-example-request"?: { method?: unknown; path?: unknown };
  "x-vibeflow-example-note"?: unknown;
}

function loadSpecOps(): { path: string; method: string; op: SpecOperation }[] {
  const doc = JSON.parse(
    readFileSync(join(REPO_ROOT, "docs", "api", "openapi.json"), "utf-8"),
  ) as { paths: Record<string, Record<string, SpecOperation>> };
  const out: { path: string; method: string; op: SpecOperation }[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method: method.toUpperCase(), op });
    }
  }
  return out;
}

/** Registry `{param}` template vs a concrete example path. */
function templateMatches(template: string, examplePath: string): boolean {
  const bare = examplePath.split("?")[0];
  const re = new RegExp(
    "^" +
      template
        .split(/{\w+}/)
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]+") +
      "$",
  );
  return re.test(bare);
}

const CREATED_201 = new Set([
  "create-task",
  "create-token",
  "create-board",
  "add-link",
]);

describe("docs coverage guard: examples cover every registry route", () => {
  it("examples key set equals the registry op id set, both directions", () => {
    const registryIds = loadRegistryIds().map((o) => o.id).sort();
    const exampleIds = Object.keys(loadExamples()).sort();
    const missing = registryIds.filter((id) => !exampleIds.includes(id));
    const extra = exampleIds.filter((id) => !registryIds.includes(id));
    expect(
      { missing, extra },
      `docs drift — ops without an example: ${missing.join(", ")}; ` +
        `examples for unknown ops: ${extra.join(", ")}`,
    ).toEqual({ missing: [], extra: [] });
    expect(exampleIds.length).toBe(registryIds.length);
  });

  it("every emitted operation carries its per-endpoint example + deep-link identity", () => {
    const byId = new Map(loadRegistryIds().map((op) => [op.id, op]));
    const failures: string[] = [];
    for (const { path, method, op } of loadSpecOps()) {
      const id = op.operationId;
      if (!id || !byId.has(id)) {
        failures.push(`${method} ${path}: unknown operationId ${JSON.stringify(id)}`);
        continue;
      }
      const reg = byId.get(id) as RegistryOp;
      // Deep-link identity: Swagger UI deepLinking exposes
      // `#/<tag>/<operationId>` — no tag, no anchor.
      if (!Array.isArray(op.tags) || op.tags.length === 0) {
        failures.push(`${id}: no tag — no deep-link anchor derivable`);
      }
      const xr = op["x-vibeflow-example-request"];
      if (!xr || typeof xr !== "object") {
        failures.push(`${id}: missing x-vibeflow-example-request`);
        continue;
      }
      if (xr.method !== reg.method) {
        failures.push(`${id}: example method ${JSON.stringify(xr.method)} !== ${reg.method}`);
      }
      if (typeof xr.path !== "string" || !templateMatches(reg.v0Path, xr.path)) {
        failures.push(`${id}: example path ${JSON.stringify(xr.path)} does not match ${reg.v0Path}`);
      }
      // Standard OpenAPI examples on the JSON wire shapes, so the viewer
      // renders them inline (binary download is the exempt case — it
      // carries x-vibeflow-example-note instead of a JSON body).
      const wantStatus = CREATED_201.has(id) ? "201" : "200";
      const jsonMedia = op.responses?.[wantStatus]?.content?.["application/json"];
      const example = loadExamples()[id] as {
        request?: { body?: unknown };
        response?: { body?: unknown; note?: unknown };
      };
      if (example?.response?.body !== undefined) {
        if (jsonMedia?.examples === undefined) {
          failures.push(`${id}: JSON success response lacks examples`);
        }
      } else if (example?.response?.note === undefined) {
        failures.push(`${id}: example needs a response body or a note`);
      }
      if (
        example?.request?.body !== undefined &&
        op.requestBody?.content?.["application/json"] &&
        op.requestBody.content["application/json"].examples === undefined
      ) {
        failures.push(`${id}: JSON requestBody lacks examples`);
      }
    }
    expect(failures, `undocumented operation(s):\n${failures.join("\n")}`).toEqual([]);
  });

  it("every registry route is emitted (guard is not vacuous on the spec side)", () => {
    const registryIds = new Set(loadRegistryIds().map((o) => o.id));
    const emittedIds = new Set(
      loadSpecOps().map((s) => s.op.operationId as string),
    );
    expect(emittedIds).toEqual(registryIds);
  });

  it("the viewer keeps deep links live (deepLinking over the served spec)", () => {
    const source = readFileSync(
      join(SRC_ROOT, "server", "docs.ts"),
      "utf-8",
    );
    expect(source, "viewer must enable Swagger UI deepLinking").toContain(
      "deepLinking: true",
    );
    expect(source, "viewer must render the served contract").toContain(
      "/api/openapi.json",
    );
  });
});

describe("docs coverage guard support: the lint is non-vacuous", () => {
  it("synthetic drift is reported (missing entry, unknown id, method/path mismatch)", async () => {
    const gen = (await import(
      "../../../../api-core/scripts/gen-api-artifacts.mjs"
    )) as typeof import("../../../../api-core/scripts/gen-api-artifacts.mjs");
    const contract = {
      operations: [
        { id: "a-op", method: "GET", v0Path: "/api/v0/things" },
        { id: "b-op", method: "POST", v0Path: "/api/v0/things/{id}" },
      ],
    };
    // As the generator emits it (applyExample already merged): the marker
    // plus standard examples on the JSON wire shapes.
    const cleanDoc = {
      paths: {
        "/api/v0/things": {
          get: {
            operationId: "a-op",
            "x-vibeflow-example-request": { method: "GET", path: "/api/v0/things" },
            responses: { 200: { content: { "application/json": { schema: {}, examples: { documented: { value: { items: [] } } } } } } } },
          },
        "/api/v0/things/{id}": {
          post: {
            operationId: "b-op",
            "x-vibeflow-example-request": { method: "POST", path: "/api/v0/things/x" },
            requestBody: { content: { "application/json": { schema: {}, examples: { documented: { value: {} } } } } },
            responses: { 200: { content: { "application/json": { schema: {}, examples: { documented: { value: { ok: true } } } } } } } },
          },
      },
    };
    const cleanExamples = {
      "a-op": {
        request: { method: "GET", path: "/api/v0/things" },
        response: { status: 200, body: { items: [] } },
      },
      "b-op": {
        request: { method: "POST", path: "/api/v0/things/x", body: {} },
        response: { status: 200, body: { ok: true } },
      },
    };
    // Clean synthetic pair passes.
    expect(
      gen.lintExampleCoverage(cleanDoc, contract, cleanExamples),
    ).toEqual([]);
    // Missing entry.
    const { "a-op": _drop, ...missingOne } = cleanExamples;
    expect(
      gen.lintExampleCoverage(cleanDoc, contract, missingOne).join("\n"),
    ).toContain("a-op");
    // Unknown id.
    expect(
      gen.lintExampleCoverage(cleanDoc, contract, {
        ...cleanExamples,
        "ghost-op": { request: { method: "GET", path: "/" }, response: {} },
      }).join("\n"),
    ).toContain("ghost-op");
    // Method + path mismatch.
    expect(
      gen.lintExampleCoverage(
        cleanDoc,
        contract,
        {
          ...cleanExamples,
          "b-op": {
            request: { method: "DELETE", path: "/api/v0/elsewhere" },
            response: { status: 200, body: {} },
          },
        },
      ).length,
    ).toBeGreaterThan(0);
    // Emitted op without the merged example marker.
    const stripped = JSON.parse(JSON.stringify(cleanDoc)) as typeof cleanDoc;
    delete (stripped.paths["/api/v0/things"].get as Record<string, unknown>)[
      "x-vibeflow-example-request"
    ];
    expect(
      gen.lintExampleCoverage(stripped, contract, cleanExamples).length,
    ).toBeGreaterThan(0);
  });
});
