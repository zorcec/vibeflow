#!/usr/bin/env node
/**
 * Generate every checked-in API artifact from docs/api/v0-contract.json +
 * docs/api/v0-examples.json.
 *
 * Single source of truth: docs/api/v0-contract.json (hand-authored, reviewed)
 * for the route set, plus docs/api/v0-examples.json (hand-authored,
 * reviewed) for one illustrative request/response example per operation.
 * Generated outputs (NEVER hand-edited — a freshness test fails otherwise):
 *   docs/api/openapi.yaml                        — the /api/v0 contract doc
 *   docs/api/openapi.json                        — canonical JSON twin
 *   packages/api-core/src/route-registry.gen.ts  — typed route registry
 *   packages/cli/src/server/openapi.gen.ts       — byte-exact served payload
 *     (OPENAPI_JSON + OPENAPI_YAML: the route serves the JSON verbatim and
 *     `vibeflow openapi [--yaml]` prints either form with no server needed)
 *   packages/cli/dist/openapi.json               — shipped spec file (build
 *   packages/cli/dist/openapi.yaml               — artifact, written on every
 *     non---check run so the published package carries the same generated
 *     bytes; --check skips it and the openapi-ship guard pins it instead)
 *
 * Zero dependencies (node builtins only). Deterministic: key order follows
 * construction order, so re-running emits byte-identical files.
 *
 * Usage: node scripts/gen-api-artifacts.mjs [--check]
 *   --check exits non-zero and names the files that would change.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const CONTRACT_PATH = join(REPO_ROOT, "docs", "api", "v0-contract.json");
const EXAMPLES_PATH = join(REPO_ROOT, "docs", "api", "v0-examples.json");

/**
 * Load the per-endpoint examples file: `{ examples: { <opId>: { request,
 * response } } }`. Key parity with the contract operations is enforced by
 * `lintOpenApiDocument` (and independently by the §6.4 docs coverage
 * guard), so an operation added without an example — or an example for
 * an operation that no longer exists — fails loudly instead of rotting.
 */
export function loadExamples() {
  let raw;
  try {
    raw = readFileSync(EXAMPLES_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `gen-api-artifacts: cannot read the examples at ${EXAMPLES_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `gen-api-artifacts: ${EXAMPLES_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed.examples) || typeof parsed.examples !== "object" || parsed.examples === null) {
    throw new Error(
      `gen-api-artifacts: ${EXAMPLES_PATH} must be { examples: { <opId>: {...} } }`,
    );
  }
  return parsed.examples;
}

export function loadContract() {
  // Fail loudly and usefully: a malformed contract is a build-time error, and
  // a bare JSON.parse here reports only "Unexpected token" with no path.
  let raw;
  try {
    raw = readFileSync(CONTRACT_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `gen-api-artifacts: cannot read the contract at ${CONTRACT_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `gen-api-artifacts: ${CONTRACT_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
                        ? "Rate limited — cloud per-token quota exceeded (reads 300/min, writes 60/min, token creation 10/hour); counters are per-replica, so the effective limit is the configured value × replicas. The response carries Retry-After."
                        : "Local-only operation on the cloud surface",
      content: { "application/json": { schema: ERROR_REF } },
    };
  }
  return out;
}

function pathParams(v0Path) {
  const params = [];
  for (const match of v0Path.matchAll(/\{(\w+)\}/g)) {
    params.push({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  return params;
}

/**
 * v0 ops that create a resource answer 201 Created (create-task,
 * create-token, create-board, add-link — the cloud answers 201 and the
 * private suites assert it). Every other op answers 200. The success key
 * below and the lint both read this one set, so the contract cannot drift
 * back to 200-for-creates without failing loudly.
 */
const CREATED_201_OPS = new Set([
  "create-task",
  "create-token",
  "create-board",
  "add-link",
]);

/** Success status the contract declares for an op: 201 for creates, 200 otherwise. */
export function successStatusFor(op) {
  return CREATED_201_OPS.has(op.id) ? 201 : 200;
}

const TAG_BY_ID = [
  [/^mcp-/, "MCP"],
  [/comment/, "Comments"],
  [/file|baseline|screenshot/, "Files"],
  [/settings|project|me|changelog/, "Meta"],
  [/verify|claim|prompt|auth-state/, "Agent"],
  [/link|opened|expanded/, "Tasks"],
  [/token/, "Auth"],
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
    "batch-create-tasks": { $ref: "#/components/schemas/TaskBatchResult" },
    "batch-preflight": { $ref: "#/components/schemas/BatchPreflight" },
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
    "list-tokens": { $ref: "#/components/schemas/TokenList" },
    "create-token": { $ref: "#/components/schemas/TokenSecret" },
    "revoke-token": {
      type: "object",
      properties: { success: { type: "boolean" } },
      required: ["success"],
    },
  };
  return schemaById[op.id] ?? { type: "object" };
}

function requestBodyFor(op) {
  const bodies = {
    "create-task": {
      schema: { $ref: "#/components/schemas/TaskCreate" },
      required: true,
    },
    "batch-create-tasks": {
      schema: { $ref: "#/components/schemas/TaskBatchCreate" },
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
    "create-token": {
      schema: { $ref: "#/components/schemas/TokenCreate" },
      required: true,
    },
  };
  const found = bodies[op.id];
  if (!found) return undefined;
  if (op.id === "upload-file") return undefined;
  return {
    required: found.required ?? false,
    content: { "application/json": { schema: found.schema } },
  };
}

/**
 * Merge one operation's hand-authored example into its emitted OpenAPI
 * operation (Phase 5 docs polish). Every op gets:
 * - `x-vibeflow-example-request` { method, path }: the curl-able shape,
 *   always present (even bodyless GETs and binary up/downloads),
 * - standard `examples: { documented: { value } }` on the JSON request
 *   media type when the example carries a request body,
 * - standard `examples` on the JSON success media type when the example
 *   carries a response body, or `x-vibeflow-example-note` when the
 *   response has no JSON body to example (binary download).
 */
export function applyExample(operation, op, example, successStatus) {
  operation["x-vibeflow-example-request"] = {
    method: example.request.method,
    path: example.request.path,
  };
  const requestBody = operation.requestBody;
  if (
    example.request.body !== undefined &&
    requestBody?.content?.["application/json"]
  ) {
    requestBody.content["application/json"].examples = {
      documented: { value: example.request.body },
    };
  }
  const success = operation.responses?.[String(successStatus)];
  const jsonMedia = success?.content?.["application/json"];
  if (example.response?.body !== undefined && jsonMedia) {
    jsonMedia.examples = {
      documented: { value: example.response.body },
    };
  } else if (
    example.response?.body === undefined &&
    typeof example.response?.note === "string"
  ) {
    operation["x-vibeflow-example-note"] = example.response.note;
  }
}

export function buildOpenApiDocument(contract, examples = loadExamples()) {
  const paths = {};
  for (const op of contract.operations) {
    const pathItem = paths[op.v0Path] ?? {};
    const method = op.method.toLowerCase();
    const hasIdParam = op.v0Path.includes("{id}");
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
      parameters: pathParams(op.v0Path),
      responses: {
        [successStatusFor(op)]: {
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
        {
          name: "sort",
          in: "query",
          description:
            "Ordering contract for the page (ticket 05076246): `kanban` pages the board in the client's listing order (status rank, priority rank, created desc, id) so `limit` means \"this page, in that order\" and a top-K read costs one request. Absent = the historical `createdAt DESC` default, so old clients see identical results. Any other value is 400 INVALID_SORT, never a silent fallback.",
          schema: { type: "string", enum: ["kanban"] },
        },
        {
          name: "scope",
          in: "query",
          description:
            "Scope contract for the page (ticket 05076246, LANE Z): `roots` restricts the page AND the total to root tasks (a task whose own links carry no parent edge — the server image of the client's root-only filter). Absent = every board row, unchanged. Any other value is 400 INVALID_SCOPE, never a silent fallback.",
          schema: { type: "string", enum: ["roots"] },
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
    const example = examples[op.id];
    if (example) {
      applyExample(operation, op, example, successStatusFor(op));
    }
    pathItem[method] = operation;
    paths[op.v0Path] = pathItem;
  }

  return {
    openapi: contract.openapi.version,
    info: {
      title: contract.openapi.title,
      version: contract.openapi.apiVersion,
      description: contract.openapi.description,
    },
    // Root, not "/api/v0": paths below are absolute (they already carry the
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
        "v0 canonical task = local Task fields plus external id, counts, and createdAt alias. D3: responses carry BOTH id and externalId.",
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
    TaskBatchCreate: {
      type: "object",
      description:
        "Body of POST /api/v0/tasks/batch (ticket b4c525fa): one chunk of single-create bodies (max 100/req — the server answers 400 BATCH_TOO_LARGE over the cap). Each item accepts the TaskCreate field set.",
      properties: {
        items: {
          type: "array",
          maxItems: 100,
          items: { $ref: "#/components/schemas/TaskCreate" },
        },
        boardId: { type: "string" },
      },
      required: ["items"],
    },
    TaskBatchResult: {
      type: "object",
      description:
        "Envelope of POST /api/v0/tasks/batch (ticket b4c525fa): ALWAYS 200 past request-level validation — per-item failures are data, never transport errors. `results` aligns to request order (the links-phase idMap); `quota` carries post-batch remaining capacity for the CLI chunk loop.",
      properties: {
        created: { type: "integer" },
        failed: { type: "integer" },
        results: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
              {
                type: "object",
                properties: {
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string" },
                      message: { type: "string" },
                    },
                    required: ["code", "message"],
                  },
                },
                required: ["error"],
              },
            ],
          },
        },
        quota: {
          type: "object",
          properties: {
            openRemaining: { type: "integer", nullable: true },
            totalRemaining: { type: "integer", nullable: true },
          },
        },
      },
      required: ["created", "failed", "results"],
    },
    BatchPreflight: {
      type: "object",
      description:
        "Envelope of GET /api/v0/tasks/batch (ticket b4c525fa): remaining task capacity BEFORE the first batch POST. Limits (and remainings) are null when the plan caps nothing on that dimension.",
      properties: {
        maxItems: { type: "integer" },
        plan: { type: "string" },
        openLimit: { type: "integer", nullable: true },
        openUsed: { type: "integer" },
        openRemaining: { type: "integer", nullable: true },
        totalLimit: { type: "integer", nullable: true },
        totalUsed: { type: "integer" },
        totalRemaining: { type: "integer", nullable: true },
      },
      required: ["maxItems", "plan"],
    },
    TaskCreate: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: statusEnum },
        selector: { type: "string", description: "Optional in v0 (annotation is local-only); required by the local handler today" },
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
      description:
        "Body of POST /api/v0/tasks/{id}/links. Field names match what BOTH implementations actually read (the cloud v0 route and the local /api/tasks/:id handler): `taskId` is the id of the task to link TO. The earlier `target` spelling was wrong — a client following it got a 400.",
      properties: {
        type: { type: "string", enum: ["parent", "relates", "blocks"] },
        taskId: {
          type: "string",
          description: "Id of the task to link to (external id on the cloud, local id locally)",
        },
      },
      required: ["type", "taskId"],
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
    Token: {
      type: "object",
      description: "Prefix-only token row — the secret is never re-revealable (plan §4.5).",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        prefix: { type: "string", description: "Display prefix, e.g. vbf_pat_9f2c…" },
        scopes: { type: "array", items: { type: "string" } },
        lastUsedAt: { type: "string", format: "date-time", nullable: true },
        expiresAt: { type: "string", format: "date-time", nullable: true },
        revokedAt: { type: "string", format: "date-time", nullable: true },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id", "name", "prefix", "scopes"],
    },
    TokenList: {
      type: "object",
      properties: {
        tokens: { type: "array", items: { $ref: "#/components/schemas/Token" } },
      },
      required: ["tokens"],
    },
    TokenCreate: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        scopes: { type: "array", items: { type: "string" } },
        expiresAt: { type: "string", format: "date-time", nullable: true },
      },
      required: ["name", "scopes"],
    },
    TokenSecret: {
      type: "object",
      description: "Creation response — the secret appears here exactly once (plan §4.5).",
      properties: {
        token: { type: "string", description: "Full vbf_pat_ secret — shown once, never stored" },
        id: { type: "string" },
        name: { type: "string" },
        prefix: { type: "string" },
        scopes: { type: "array", items: { type: "string" } },
        expiresAt: { type: "string", format: "date-time", nullable: true },
      },
      required: ["token", "id", "name", "prefix", "scopes"],
    },
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

/**
 * Example-shape lint: the emitted operation must carry the example the
 * examples file documents for it. Returns problem strings (empty = clean).
 * Exported so the §6.4 docs coverage guard can prove non-vacuity on
 * synthetic drift without touching real files.
 */
export function lintExampleCoverage(doc, contract, examples) {
  const problems = [];
  const opIds = new Set(contract.operations.map((op) => op.id));
  for (const id of Object.keys(examples)) {
    if (!opIds.has(id)) problems.push(`example for unknown operation ${JSON.stringify(id)}`);
  }
  const byOperationId = new Map();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (op?.operationId) byOperationId.set(op.operationId, { path, method, op });
    }
  }
  for (const op of contract.operations) {
    const example = examples[op.id];
    if (!example || typeof example !== "object") {
      problems.push(`${op.id}: missing examples entry (docs cannot silently rot)`);
      continue;
    }
    if (example.request?.method !== op.method) {
      problems.push(`${op.id}: example request method ${JSON.stringify(example.request?.method)} !== ${op.method}`);
    }
    const templateRe = new RegExp(
      "^" + op.v0Path.split(/\{\w+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+") + "$",
    );
    const examplePath = typeof example.request?.path === "string" ? example.request.path.split("?")[0] : "";
    if (!templateRe.test(examplePath)) {
      problems.push(`${op.id}: example request path ${JSON.stringify(example.request?.path)} does not match ${op.v0Path}`);
    }
    const emitted = byOperationId.get(op.id);
    if (!emitted) {
      problems.push(`${op.id}: not emitted in paths (covered by the op-count lint)`);
      continue;
    }
    if (emitted.op["x-vibeflow-example-request"] === undefined) {
      problems.push(`${op.id}: emitted operation lacks x-vibeflow-example-request`);
    }
    const wantStatus = String(successStatusFor(op));
    const jsonMedia = emitted.op.responses?.[wantStatus]?.content?.["application/json"];
    if (example.response?.body !== undefined) {
      if (!jsonMedia) {
        problems.push(`${op.id}: example has a response body but ${wantStatus} has no JSON media type`);
      } else if (jsonMedia.examples?.documented?.value === undefined) {
        problems.push(`${op.id}: JSON success response lacks examples.documented`);
      }
    }
    if (
      example.request?.body !== undefined &&
      emitted.op.requestBody?.content?.["application/json"] &&
      emitted.op.requestBody.content["application/json"].examples?.documented?.value === undefined
    ) {
      problems.push(`${op.id}: JSON requestBody lacks examples.documented`);
    }
  }
  return problems;
}

export function lintOpenApiDocument(doc, contract, examples = loadExamples()) {
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
  for (const p of lintExampleCoverage(doc, contract, examples)) problems.push(p);
  const successByOperationId = new Map(
    contract.operations.map((op) => [op.id, successStatusFor(op)]),
  );
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!op.operationId) problems.push(`${method.toUpperCase()} ${path}: missing operationId`);
      const want = String(successByOperationId.get(op.operationId) ?? 200);
      if (!op.responses?.[want])
        problems.push(`${method.toUpperCase()} ${path}: missing ${want} response`);
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

const GEN_HEADER = `// AUTO-GENERATED by packages/api-core/scripts/gen-api-artifacts.mjs — do not edit.\n// Sources: docs/api/v0-contract.json + docs/api/v0-examples.json. Re-run 'pnpm --filter @vibeflow-tools/api-core gen:api'.\n`;

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
        `    v0Path: ${tsString(op.v0Path)},\n` +
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
    `import type { LocalOnlyRoute, V0Operation } from "./types.js";\n\n` +
    `/** Contract version this registry was generated from. */\n` +
    `export const SPEC_VERSION = ${tsString(contract.openapi.apiVersion)};\n\n` +
    `/** Every v0 operation with its current local handler (null = no local HTTP handler yet). */\n` +
    `export const V0_OPERATIONS: V0Operation[] = [\n${ops}\n];\n\n` +
    `/** Local handlers deliberately excluded from v0, each with its reason. */\n` +
    `export const LOCAL_ONLY_ROUTES: LocalOnlyRoute[] = [\n${localOnly}\n];\n\n` +
    `/** Non-API route prefixes carved out of the duplication guard, with reasons. */\n` +
    `export const NON_API_CARVE_OUTS: { prefix: string; reason: string }[] = [\n${carveOuts}\n];\n`
  );
}

export function emitServerEmbed(openApiJson, openApiYaml) {
  const hash = createHash("sha256").update(openApiJson).digest("hex");
  return (
    GEN_HEADER +
    `/**\n` +
    ` * Byte-exact payload served at GET /api/openapi.json.\n` +
    ` * Generated from docs/api/v0-contract.json — the route serves the JSON\n` +
    ` * string verbatim so the Phase 1 docs viewer has a drift-proof source,\n` +
    ` * and \`vibeflow openapi [--yaml]\` prints either form with no server.\n` +
    ` */\n` +
    `export const OPENAPI_JSON: string = ${tsString(openApiJson)};\n\n` +
    `/**\n` +
    ` * YAML twin of OPENAPI_JSON, from the same generator transform that\n` +
    ` * emits docs/api/openapi.yaml. Printed by \`vibeflow openapi --yaml\`.\n` +
    ` */\n` +
    `export const OPENAPI_YAML: string = ${tsString(openApiYaml)};\n\n` +
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
    [join(REPO_ROOT, "packages", "cli", "src", "server", "openapi.gen.ts"), emitServerEmbed(openApiJson, openApiYaml)],
  ];
  // Shipped spec files: the same generated bytes, written into the CLI's
  // build output so the published package carries them (package.json `files`
  // + `exports` leaves `./openapi.json` / `./openapi.yaml`). Build-only:
  // the atomic build (packages/cli/scripts/build-atomic.mjs, ticket
  // 328b5420) sets VIBEFLOW_DIST_DIR to its staging dir, so the files land
  // in the staged tree and reach the live dist/ via the sync — never by
  // writing to the live dist directly. `--check` skips them — dist is a
  // gitignored build artifact, not a checked-in file — and the
  // openapi-ship guard pins dist ⇄ docs ⇄ stdout agreement instead.
  // (node builtins only in this script, so the override is read inline
  // rather than imported from the CLI's scripts/lib helper.)
  const cliDistDir = process.env.VIBEFLOW_DIST_DIR || "dist";
  const distOutputs = [
    [join(REPO_ROOT, "packages", "cli", cliDistDir, "openapi.json"), openApiJson],
    [join(REPO_ROOT, "packages", "cli", cliDistDir, "openapi.yaml"), openApiYaml],
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
  if (!check) {
    for (const [path, content] of distOutputs) {
      let current = null;
      try {
        current = readFileSync(path, "utf-8");
      } catch {
        current = null;
      }
      if (current !== content) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        console.log(`wrote ${path}`);
      }
    }
  }
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  join(HERE, "gen-api-artifacts.mjs") === process.argv[1];

if (invokedAsScript) {
  main();
}
