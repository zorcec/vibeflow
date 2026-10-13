#!/usr/bin/env node
/**
 * Generate every checked-in API artifact from docs/api/v1-contract.json.
 *
 * Single source of truth: docs/api/v1-contract.json (hand-authored, reviewed).
 * Generated outputs (NEVER hand-edited — a freshness test fails otherwise):
 *   docs/api/openapi.yaml                        — the /api/v1 contract doc
 *   docs/api/openapi.json                        — canonical JSON twin
 *   packages/api-core/src/route-registry.gen.ts  — typed route registry
 *   packages/cli/src/server/openapi.gen.ts       — byte-exact served payload
 *
 * Zero dependencies (node builtins only). Deterministic: key order follows
 * construction order, so re-running emits byte-identical files.
 *
 * Usage: node scripts/gen-api-artifacts.mjs [--check]
 *   --check exits non-zero and names the files that would change.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const CONTRACT_PATH = join(REPO_ROOT, "docs", "api", "v1-contract.json");

export function loadContract() {
  return JSON.parse(readFileSync(CONTRACT_PATH, "utf-8"));
}

// ── Minimal deterministic YAML emitter ──────────────────────────────────────
// Emits the subset the contract document needs: nested maps (2-space indent),
// arrays, and scalars. Strings are emitted plain only when they cannot be
// misread (no leading/trailing space, no ": ", no quotes/brackets/braces,
// not a number/bool/null literal); otherwise JSON-style double quotes.

const PLAIN_RE = /^[A-Za-z0-9_][A-Za-z0-9 _.,;()+@#/%-]*$/;

function yamlScalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") {
    if (
      value.length > 0 &&
      PLAIN_RE.test(value) &&
      !/^(true|false|null|~|[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)$/.test(value)
    ) {
      return value;
    }
    return (
      '"' +
      value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t") +
      '"'
    );
  }
  throw new Error(`yaml emitter: unsupported scalar ${typeof value}`);
}

function yamlLines(value, indent) {
  const pad = "  ".repeat(indent);
  if (value === null || typeof value !== "object") {
    return [pad + yamlScalar(value)];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [pad + "[]"];
    const lines = [];
    for (const item of value) {
      if (item !== null && typeof item === "object") {
        const nested = yamlLines(item, indent + 1);
        lines.push(pad + "- " + nested[0].trimStart());
        for (const rest of nested.slice(1)) lines.push(rest);
      } else {
        lines.push(pad + "- " + yamlScalar(item));
      }
    }
    return lines;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return [pad + "{}"];
  const lines = [];
  for (const key of keys) {
    const v = value[key];
    if (v !== null && typeof v === "object") {
      lines.push(pad + yamlScalar(key) + ":");
      for (const l of yamlLines(v, indent + 1)) lines.push(l);
    } else {
      lines.push(pad + yamlScalar(key) + ": " + yamlScalar(v));
    }
  }
  return lines;
}

export function emitYaml(doc) {
  return yamlLines(doc, 0).join("\n") + "\n";
}

export function emitOpenApiJson(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}

// ── OpenAPI 3.1 document builder ────────────────────────────────────────────

const ERROR_REF = { $ref: "#/components/schemas/Error" };

function errorResponses(codes) {
  const out = {};
  for (const code of codes) {
    out[String(code)] = {
      description:
        code === 400
          ? "Malformed request (includes invalid task/comment id form)"
          : code === 401
            ? "Missing or invalid principal"
            : code === 403
              ? "Lacking scope or membership"
              : code === 404
                ? "Unknown id"
                : code === 409
                  ? "Conflict (incl. AMBIGUOUS_TASK_ID)"
                  : code === 413
                    ? "Payload too large"
                    : code === 422
                      ? "Ambiguous scope (SCOPE_REQUIRED)"
                      : code === 429
                        ? "Rate limited"
                        : "Local-only operation on the cloud surface",
      content: { "application/json": { schema: ERROR_REF } },
    };
  }
  return out;
}

function pathParams(v1Path) {
  const params = [];
  for (const match of v1Path.matchAll(/\{(\w+)\}/g)) {
    params.push({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  return params;
}

const TAG_BY_ID = [
  [/^mcp-/, "MCP"],
  [/comment/, "Comments"],
  [/file|baseline|screenshot/, "Files"],
  [/settings|project|me|changelog/, "Meta"],
  [/verify|claim|prompt|auth-state/, "Agent"],
  [/link|opened|expanded/, "Tasks"],
  [/./, "Tasks"],
];

function tagFor(id) {
  for (const [re, tag] of TAG_BY_ID) {
    if (re.test(id)) return tag;
  }
  return "Tasks";
}

function responseFor(op) {
  const schemaById = {
    "list-tasks": { $ref: "#/components/schemas/TaskList" },
    "get-task": { $ref: "#/components/schemas/Task" },
    "create-task": { $ref: "#/components/schemas/Task" },
    "patch-task": { $ref: "#/components/schemas/Task" },
    "delete-task": { $ref: "#/components/schemas/Task" },
    "mark-opened": { $ref: "#/components/schemas/Task" },
    "mark-expanded": { $ref: "#/components/schemas/Task" },
    "add-link": { $ref: "#/components/schemas/Task" },
    "remove-link": { $ref: "#/components/schemas/Task" },
    "claim-next": { $ref: "#/components/schemas/ClaimNext" },
    "verify-task": { $ref: "#/components/schemas/Task" },
    "list-comments": { $ref: "#/components/schemas/CommentList" },
    "add-comment": { $ref: "#/components/schemas/Comment" },
    "patch-comment": { $ref: "#/components/schemas/Comment" },
    "delete-comment": {
      type: "object",
      properties: { success: { type: "boolean" } },
      required: ["success"],
    },
    "list-files": { $ref: "#/components/schemas/FileList" },
    "upload-file": { $ref: "#/components/schemas/FileEntry" },
    "get-file": { type: "string", format: "binary" },
    "delete-file": {
      type: "object",
      properties: { success: { type: "boolean" } },
      required: ["success"],
    },
    "put-screenshot": { $ref: "#/components/schemas/ScreenshotResult" },
    "delete-screenshot": {
      type: "object",
      properties: { success: { type: "boolean" } },
      required: ["success"],
    },
    "put-baseline": { $ref: "#/components/schemas/BaselineResult" },
    "put-auth-state": { $ref: "#/components/schemas/AuthStateResult" },
    "get-project": { $ref: "#/components/schemas/Project" },
    "get-me": { $ref: "#/components/schemas/Principal" },
    "get-settings": { $ref: "#/components/schemas/Settings" },
    "patch-settings": { $ref: "#/components/schemas/Settings" },
    "get-changelog": { $ref: "#/components/schemas/Changelog" },
    "export-prompt": { $ref: "#/components/schemas/PromptExport" },
    "mcp-get": { $ref: "#/components/schemas/McpSession" },
    "mcp-post": { type: "object", description: "JSON-RPC response envelope" },
  };
  return schemaById[op.id] ?? { type: "object" };
}

function requestBodyFor(op) {
  const bodies = {
    "create-task": {
      schema: { $ref: "#/components/schemas/TaskCreate" },
      required: true,
    },
    "patch-task": { schema: { $ref: "#/components/schemas/TaskPatch" } },
    "add-link": {
      schema: { $ref: "#/components/schemas/TaskLinkInput" },
      required: true,
    },
    "claim-next": { schema: { $ref: "#/components/schemas/ClaimFilter" } },
    "verify-task": {
      schema: { $ref: "#/components/schemas/VerifyAttestation" },
      required: true,
    },
    "add-comment": {
      schema: { $ref: "#/components/schemas/CommentInput" },
      required: true,
    },
    "patch-comment": {
      schema: {
        type: "object",
        properties: { text: { type: "string", minLength: 1 } },
        required: ["text"],
      },
      required: true,
    },
    "put-screenshot": {
      schema: { $ref: "#/components/schemas/ScreenshotInput" },
      required: true,
    },
    "put-baseline": {
      schema: { $ref: "#/components/schemas/BaselineEnvelope" },
      required: true,
    },
    "put-auth-state": {
      schema: { $ref: "#/components/schemas/AuthStateInput" },
      required: true,
    },
    "patch-settings": {
      schema: { type: "object", description: "Settable UI preference keys" },
    },
    "export-prompt": { schema: { $ref: "#/components/schemas/PromptExportInput" } },
  };
  const found = bodies[op.id];
  if (!found) return undefined;
  if (op.id === "upload-file") return undefined;
  return {
    required: found.required ?? false,
    content: { "application/json": { schema: found.schema } },
  };
}

export function buildOpenApiDocument(contract) {
  const paths = {};
  for (const op of contract.operations) {
    const pathItem = paths[op.v1Path] ?? {};
    const method = op.method.toLowerCase();
    const hasIdParam = op.v1Path.includes("{id}");
    const codes =
      op.method === "GET"
        ? hasIdParam
          ? [404]
          : []
        : op.id === "put-auth-state"
          ? [400, 404, 501]
          : [400, 404];
    const operation = {
      operationId: op.id,
      summary: op.summary,
      description: op.notes,
      tags: [tagFor(op.id)],
      "x-vibeflow-scope": op.scope ?? "none (public)",
      "x-vibeflow-local": op.local
        ? `${op.local.method} ${op.local.path}`
        : "no local HTTP handler",
      "x-plan-row": op.planRow,
      parameters: pathParams(op.v1Path),
      responses: {
        200: {
          description: `${op.summary} — success`,
          content: { "application/json": { schema: responseFor(op) } },
        },
        ...errorResponses([...codes, 401, 403, 429]),
      },
    };
    if (op.id === "list-tasks") {
      operation.parameters.push(
        {
          name: "status",
          in: "query",
          schema: {
            type: "string",
            enum: contract.conventions.statusVocabulary,
          },
        },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1 } },
        { name: "cursor", in: "query", schema: { type: "string" } },
      );
    }
    if (op.id === "upload-file") {
      operation.requestBody = {
        required: true,
        content: {
          "application/octet-stream": { schema: { type: "string", format: "binary" } },
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: { file: { type: "string", format: "binary" } },
            },
          },
        },
      };
    } else {
      const body = requestBodyFor(op);
      if (body) operation.requestBody = body;
    }
    if (op.id === "get-file") {
      operation.responses["200"] = {
        description: "File bytes",
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      };
    }
    if (op.scope !== null) {
      operation.security = [{ bearerAuth: [] }];
    }
    pathItem[method] = operation;
    paths[op.v1Path] = pathItem;
  }

  return {
    openapi: contract.openapi.version,
    info: {
      title: contract.openapi.title,
      version: contract.openapi.apiVersion,
      description: contract.openapi.description,
    },
    // Root, not "/api/v1": paths below are absolute (they already carry the
    // prefix), so a mount-valued server URL would double it and every
    // try-it-out call would 404 (found via the /api/docs viewer, P1).
    servers: [{ url: "/", description: "Local board — try-it-out executes against this server" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "vbf_pat" },
      },
      schemas: buildSchemas(contract),
    },
  };
}

function buildSchemas(contract) {
  const statusEnum = contract.conventions.statusVocabulary;
  return {
    Task: {
      type: "object",
      description:
        "v1 canonical task = local Task fields plus external id, counts, and createdAt alias. D3: responses carry BOTH id and externalId.",
      properties: {
        id: { type: "string", description: "External id (cli_id ?? id on cloud; the local id locally)" },
        externalId: { type: "string", description: "Universal external id — equal to id on the local surface" },
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: statusEnum },
        selector: { type: "string" },
        priority: { type: "string" },
        verified: { type: "boolean", nullable: true },
        links: { type: "array", items: { $ref: "#/components/schemas/TaskLink" } },
        commentCount: { type: "integer" },
        fileCount: { type: "integer" },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id", "externalId", "title", "status"],
    },
    TaskSummary: {
      type: "object",
      properties: {
        id: { type: "string" },
        externalId: { type: "string" },
        title: { type: "string" },
        status: { type: "string", enum: statusEnum },
        commentCount: { type: "integer" },
        fileCount: { type: "integer" },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id", "externalId", "title", "status"],
    },
    TaskList: {
      type: "object",
      properties: {
        items: { type: "array", items: { $ref: "#/components/schemas/TaskSummary" } },
        nextCursor: { type: "string", nullable: true },
      },
      required: ["items"],
    },
    TaskCreate: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: statusEnum },
        selector: { type: "string", description: "Optional in v1 (annotation is local-only); required by the local handler today" },
        priority: { type: "string" },
      },
      required: ["title"],
    },
    TaskPatch: {
      type: "object",
      description: "All fields optional; status speaks the hyphenated set",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: statusEnum },
        priority: { type: "string" },
        verified: { type: "boolean", nullable: true },
      },
    },
    TaskLink: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        type: { type: "string", enum: ["parent", "relates", "blocks"] },
      },
      required: ["taskId", "type"],
    },
    TaskLinkInput: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["parent", "relates", "blocks"] },
        target: { type: "string" },
      },
      required: ["type", "target"],
    },
    ClaimFilter: {
      type: "object",
      properties: {
        status: { type: "string", enum: statusEnum },
        tags: { type: "array", items: { type: "string" } },
      },
    },
    ClaimNext: {
      type: "object",
      properties: {
        task: {
          oneOf: [
            { $ref: "#/components/schemas/Task" },
            { type: "null", description: "No actionable task" },
          ],
        },
      },
      required: ["task"],
    },
    VerifyAttestation: {
      type: "object",
      description: "Agent attestation tri-state: pass/fail/cannot (+reason). 'cannot' also writes the Cannot-verify comment.",
      properties: {
        verdict: { type: "string", enum: ["pass", "fail", "cannot"] },
        reason: { type: "string" },
      },
      required: ["verdict"],
    },
    Comment: {
      type: "object",
      description: "Ledger L1: author is explicit and preserved end to end.",
      properties: {
        id: { type: "string" },
        author: { type: "string", enum: contract.conventions.commentAuthors },
        text: { type: "string" },
        type: { type: "string", enum: ["comment", "system"] },
        source: { type: "string", enum: ["cli", "web"] },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id", "author", "text"],
    },
    CommentList: {
      type: "object",
      properties: {
        items: { type: "array", items: { $ref: "#/components/schemas/Comment" } },
        nextCursor: { type: "string", nullable: true },
      },
      required: ["items"],
    },
    CommentInput: {
      type: "object",
      properties: {
        author: { type: "string", enum: contract.conventions.commentAuthors },
        text: { type: "string", minLength: 1 },
      },
      required: ["text"],
    },
    FileEntry: {
      type: "object",
      properties: {
        name: { type: "string" },
        size: { type: "integer" },
        mimeType: { type: "string" },
        system: { type: "boolean" },
      },
      required: ["name"],
    },
    FileList: {
      type: "object",
      properties: {
        items: { type: "array", items: { $ref: "#/components/schemas/FileEntry" } },
        nextCursor: { type: "string", nullable: true },
      },
      required: ["items"],
    },
    ScreenshotResult: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        screenshot: { type: "string" },
      },
      required: ["success"],
    },
    ScreenshotInput: {
      type: "object",
      properties: { screenshot: { type: "string", contentEncoding: "base64" } },
      required: ["screenshot"],
    },
    BaselineResult: {
      type: "object",
      properties: { success: { type: "boolean" } },
      required: ["success"],
    },
    BaselineEnvelope: {
      type: "object",
      description: "Merges the two local baseline routes into one envelope",
      properties: {
        baseline: { type: "object", description: "Element snapshot { selector, outerHTML }" },
        page: { type: "object", description: "Page-wide snapshot { version, elements, capturedAt }" },
      },
    },
    AuthStateResult: {
      type: "object",
      properties: { success: { type: "boolean" } },
      required: ["success"],
    },
    AuthStateInput: {
      type: "object",
      properties: {
        authState: { type: "object" },
        taskAuthor: { type: "string" },
      },
      required: ["authState", "taskAuthor"],
    },
    Project: {
      type: "object",
      description: "Scope description: local { kind: local, name, branch }; cloud { kind: board, ... }",
      properties: {
        kind: { type: "string", enum: ["local", "board"] },
        name: { type: "string" },
        branch: { type: "string", nullable: true },
        boardId: { type: "string" },
        workspaceId: { type: "string" },
      },
      required: ["kind"],
    },
    Principal: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["local", "user"] },
        userId: { type: "string" },
        scopes: { type: "array", items: { type: "string" } },
      },
      required: ["kind"],
    },
    Settings: { type: "object", description: "UI preference keys" },
    Changelog: { type: "object", description: "CLI changelog payload" },
    PromptExport: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
    PromptExportInput: {
      type: "object",
      properties: { scope: { type: "string", enum: ["task", "board"] } },
    },
    McpSession: { type: "object", description: "StreamableHTTP session descriptor" },
    Error: {
      type: "object",
      properties: {
        error: { type: "string" },
        code: { type: "string" },
        details: { type: "object" },
      },
      required: ["error"],
    },
  };
}

// ── Structural lint (runs inside generation; fails loudly, not silently) ────

export function lintOpenApiDocument(doc, contract) {
  const problems = [];
  if (!/^3\.1\.\d+$/.test(doc.openapi ?? "")) {
    problems.push(`openapi version must be 3.1.x, got ${JSON.stringify(doc.openapi)}`);
  }
  for (const key of ["info", "paths", "components"]) {
    if (doc[key] === undefined) problems.push(`missing top-level ${key}`);
  }
  const opCount = contract.operations.length;
  const pathOpCount = Object.values(doc.paths).reduce(
    (n, item) => n + Object.keys(item).length,
    0,
  );
  if (pathOpCount !== opCount) {
    problems.push(`paths carry ${pathOpCount} operations but the contract lists ${opCount}`);
  }
  const refs = new Set();
  const collectRefs = (node) => {
    if (Array.isArray(node)) {
      for (const v of node) collectRefs(v);
    } else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref" && typeof v === "string") refs.add(v);
        else collectRefs(v);
      }
    }
  };
  collectRefs(doc);
  for (const ref of refs) {
    const match = ref.match(/^#\/components\/schemas\/([\w-]+)$/);
    if (!match) {
      problems.push(`non-local $ref ${ref}`);
      continue;
    }
    if (doc.components.schemas[match[1]] === undefined) {
      problems.push(`unresolvable $ref ${ref}`);
    }
  }
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!op.operationId) problems.push(`${method.toUpperCase()} ${path}: missing operationId`);
      if (!op.responses?.["200"]) problems.push(`${method.toUpperCase()} ${path}: missing 200 response`);
      for (const p of op.parameters ?? []) {
        if (p.in === "path" && !path.includes(`{${p.name}}`)) {
          problems.push(`${method.toUpperCase()} ${path}: path param ${p.name} not in path`);
        }
      }
    }
  }
  return problems;
}

// ── Registry + embed emitters ───────────────────────────────────────────────

const GEN_HEADER = `// AUTO-GENERATED by packages/api-core/scripts/gen-api-artifacts.mjs — do not edit.\n// Source: docs/api/v1-contract.json. Re-run 'pnpm --filter @vibeflow-tools/api-core gen:api'.\n`;

function tsString(value) {
  return JSON.stringify(value);
}

export function emitRegistry(contract) {
  const ops = contract.operations
    .map((op) => {
      const local = op.local
        ? `{ method: ${tsString(op.local.method)}, path: ${tsString(op.local.path)} }`
        : "null";
      return (
        `  {\n` +
        `    id: ${tsString(op.id)},\n` +
        `    method: ${tsString(op.method)},\n` +
        `    v1Path: ${tsString(op.v1Path)},\n` +
        `    local: ${local},\n` +
        `    scope: ${op.scope === null ? "null" : tsString(op.scope)},\n` +
        `    planRow: ${op.planRow},\n` +
        `    summary: ${tsString(op.summary)},\n` +
        `    notes: ${tsString(op.notes)},\n` +
        `  },`
      );
    })
    .join("\n");
  const localOnly = contract.localOnly
    .map(
      (r) =>
        `  { method: ${tsString(r.method)}, path: ${tsString(r.path)}, reason: ${tsString(r.reason)} },`,
    )
    .join("\n");
  const carveOuts = contract.nonApiCarveOuts
    .map(
      (r) =>
        `  { prefix: ${tsString(r.prefix)}, reason: ${tsString(r.reason)} },`,
    )
    .join("\n");
  return (
    GEN_HEADER +
    `import type { LocalOnlyRoute, V1Operation } from "./types.js";\n\n` +
    `/** Contract version this registry was generated from. */\n` +
    `export const SPEC_VERSION = ${tsString(contract.openapi.apiVersion)};\n\n` +
    `/** Every v1 operation with its current local handler (null = no local HTTP handler yet). */\n` +
    `export const V1_OPERATIONS: V1Operation[] = [\n${ops}\n];\n\n` +
    `/** Local handlers deliberately excluded from v1, each with its reason. */\n` +
    `export const LOCAL_ONLY_ROUTES: LocalOnlyRoute[] = [\n${localOnly}\n];\n\n` +
    `/** Non-API route prefixes carved out of the duplication guard, with reasons. */\n` +
    `export const NON_API_CARVE_OUTS: { prefix: string; reason: string }[] = [\n${carveOuts}\n];\n`
  );
}

export function emitServerEmbed(openApiJson) {
  const hash = createHash("sha256").update(openApiJson).digest("hex");
  return (
    GEN_HEADER +
    `/**\n` +
    ` * Byte-exact payload served at GET /api/openapi.json.\n` +
    ` * Generated from docs/api/v1-contract.json — the route serves this string\n` +
    ` * verbatim so the Phase 1 docs viewer has a drift-proof source.\n` +
    ` */\n` +
    `export const OPENAPI_JSON: string = ${tsString(openApiJson)};\n\n` +
    `/** SHA-256 of OPENAPI_JSON, for identity assertions. */\n` +
    `export const OPENAPI_SHA256: string = ${tsString(hash)};\n`
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const check = process.argv.includes("--check");
  const contract = loadContract();
  const doc = buildOpenApiDocument(contract);
  const problems = lintOpenApiDocument(doc, contract);
  if (problems.length > 0) {
    console.error("openapi lint failed:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const openApiJson = emitOpenApiJson(doc);
  const openApiYaml = emitYaml(doc);
  const outputs = [
    [join(REPO_ROOT, "docs", "api", "openapi.json"), openApiJson],
    [join(REPO_ROOT, "docs", "api", "openapi.yaml"), openApiYaml],
    [join(REPO_ROOT, "packages", "api-core", "src", "route-registry.gen.ts"), emitRegistry(contract)],
    [join(REPO_ROOT, "packages", "cli", "src", "server", "openapi.gen.ts"), emitServerEmbed(openApiJson)],
  ];
  let dirty = [];
  for (const [path, content] of outputs) {
    let current = null;
    try {
      current = readFileSync(path, "utf-8");
    } catch {
      current = null;
    }
    if (current !== content) {
      if (check) {
        dirty.push(path);
      } else {
        writeFileSync(path, content);
        console.log(`wrote ${path}`);
      }
    }
  }
  if (check && dirty.length > 0) {
    console.error("stale generated artifacts (re-run gen:api):");
    for (const p of dirty) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (check) console.log("generated artifacts fresh");
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  join(HERE, "gen-api-artifacts.mjs") === process.argv[1];

if (invokedAsScript) {
  main();
}
