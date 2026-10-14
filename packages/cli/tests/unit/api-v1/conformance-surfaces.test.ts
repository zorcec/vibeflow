/**
 * Conformance runner surface option (P3 step 14).
 *
 * Stub-transport unit tests — no server boot. Pins the contract:
 * - `local` (default): bit-identical to the Phase 0 gate — `local-read`
 *   entries with a local handler execute against the authored (local) path;
 *   everything else skips with its target phase. The `surfaces` manifest
 *   field must not change local behaviour.
 * - `cloud`: entries whose `surfaces` include "cloud" execute against the
 *   v1 path translation (`toSurfacePath`); every other entry skips BY NAME
 *   with its manifest `cloudSkipReason` (or a fallback that still names the
 *   phase and runnable label — never silent).
 */

import { describe, it, expect } from "vitest";
import {
  runConformance,
  toSurfacePath,
  type ManifestEntry,
  type RunnerTransport,
} from "@vibeflow-tools/api-core";

interface Seen {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

function stubTransport(
  seen: Seen[],
  respond: (call: Seen) => { status: number; body: unknown } = () => ({
    status: 200,
    body: { tasks: [] },
  }),
): RunnerTransport {
  return {
    async fetchJson(method, path, options) {
      const call: Seen = {
        method,
        path,
        query: options?.query,
        body: options?.body,
      };
      seen.push(call);
      return respond(call);
    },
  };
}

const LOCAL_READ: ManifestEntry = {
  id: "list-tasks",
  v1: { method: "GET", path: "/api/v1/tasks" },
  local: { method: "GET", path: "/api/tasks" },
  runnable: "local-read",
  phase: 0,
  surfaces: ["local", "cloud"],
  cases: [
    {
      name: "green",
      request: { method: "GET", path: "/api/tasks" },
      expect: { status: 200, shape: "task-list" },
    },
  ],
};

const SEEDED_READ: ManifestEntry = {
  id: "get-task",
  v1: { method: "GET", path: "/api/v1/tasks/{id}" },
  local: { method: "GET", path: "/api/tasks/{taskId}" },
  runnable: "local-read",
  phase: 0,
  surfaces: ["local", "cloud"],
  seed: { taskId: "abc123" },
  cases: [
    {
      name: "green",
      request: { method: "GET", path: "/api/tasks/{taskId}" },
      expect: { status: 200, shape: "task" },
    },
  ],
};

const WRITE: ManifestEntry = {
  id: "create-task",
  v1: { method: "POST", path: "/api/v1/tasks" },
  local: { method: "POST", path: "/api/tasks" },
  runnable: "write",
  phase: 3,
  surfaces: ["local", "cloud"],
  cases: [
    {
      name: "minimal-no-selector",
      request: { method: "POST", path: "/api/tasks", body: { title: "v1 minimal" } },
      expect: { status: 201, shape: "task" },
    },
  ],
};

const LOCAL_ONLY: ManifestEntry = {
  id: "get-project",
  v1: { method: "GET", path: "/api/v1/project" },
  local: { method: "GET", path: "/api/project" },
  runnable: "local-read",
  phase: 0,
  surfaces: ["local"],
  cloudSkipReason: "local-only: no cloud GET /api/v1/project; skipped on the cloud surface",
  cases: [
    {
      name: "green",
      request: { method: "GET", path: "/api/project" },
      expect: { status: 200, shape: "project" },
    },
  ],
};

const NOWHERE: ManifestEntry = {
  id: "mcp-get",
  v1: { method: "GET", path: "/mcp" },
  local: { method: "GET", path: "/api/mcp" },
  runnable: "phase-4",
  phase: 4,
  surfaces: [],
  cloudSkipReason: "P4: hosted MCP is not a v1 operation on either surface yet; skipped",
  cases: [
    {
      name: "session",
      request: { method: "GET", path: "/api/mcp" },
      expect: { status: 200 },
    },
  ],
};

describe("toSurfacePath: local base becomes the v1 base on cloud", () => {
  it("rewrites the exact local base and longer local paths", () => {
    expect(toSurfacePath(LOCAL_READ, "/api/tasks", "cloud")).toBe("/api/v1/tasks");
    expect(toSurfacePath(SEEDED_READ, "/api/tasks/{taskId}", "cloud")).toBe(
      "/api/v1/tasks/{taskId}",
    );
  });

  it("rewrites literal-id local paths (unknown-id probes stay probes)", () => {
    const entry: ManifestEntry = {
      ...SEEDED_READ,
      cases: [],
    };
    expect(
      toSurfacePath(entry, "/api/tasks/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "cloud"),
    ).toBe("/api/v1/tasks/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("leaves already-v1 case paths and handler-less entries untouched", () => {
    const alreadyV1: ManifestEntry = {
      id: "claim-next",
      v1: { method: "POST", path: "/api/v1/tasks/claim-next" },
      local: null,
      runnable: "no-local-handler",
      phase: 3,
      surfaces: ["local", "cloud"],
      cases: [],
    };
    expect(toSurfacePath(alreadyV1, "/api/v1/tasks/claim-next", "cloud")).toBe(
      "/api/v1/tasks/claim-next",
    );
    const mixed: ManifestEntry = {
      id: "add-link",
      v1: { method: "POST", path: "/api/v1/tasks/{id}/links" },
      local: { method: "PATCH", path: "/api/tasks/{taskId}" },
      runnable: "write",
      phase: 3,
      surfaces: ["local", "cloud"],
      cases: [],
    };
    expect(
      toSurfacePath(mixed, "/api/v1/tasks/{taskId}/links", "cloud"),
    ).toBe("/api/v1/tasks/{taskId}/links");
  });

  it("never rewrites on local — the authored path is the request", () => {
    expect(toSurfacePath(SEEDED_READ, "/api/tasks/{taskId}", "local")).toBe(
      "/api/tasks/{taskId}",
    );
  });
});

describe("runConformance local default is bit-identical to Phase 0", () => {
  it("executes local-read against the authored path and skips the rest by phase", async () => {
    const seen: Seen[] = [];
    const report = await runConformance(
      [LOCAL_READ, WRITE, NOWHERE],
      stubTransport(seen, () => ({ status: 200, body: { tasks: [] } })),
    );
    expect(seen).toEqual([
      { method: "GET", path: "/api/tasks", query: undefined, body: undefined },
    ]);
    expect(report.passed.map((r) => r.caseName)).toEqual(["green"]);
    expect(report.failed).toEqual([]);
    const byEntry = new Map(report.skipped.map((s) => [s.entryId, s.detail]));
    expect(byEntry.get("create-task")).toMatch(/runnable=write \(phase 3\)/);
    expect(byEntry.get("mcp-get")).toMatch(/runnable=phase-4 \(phase 4\)/);
  });

  it("the surfaces field does not change local behaviour", async () => {
    const seen: Seen[] = [];
    // Same entries, explicit surface: "local" — identical decisions.
    const report = await runConformance(
      [LOCAL_READ, WRITE, LOCAL_ONLY],
      stubTransport(seen, (c) =>
        c.path === "/api/project"
          ? { status: 200, body: {} }
          : { status: 200, body: { tasks: [] } },
      ),
      { surface: "local" },
    );
    expect(seen.map((s) => s.path).sort()).toEqual(["/api/project", "/api/tasks"]);
    expect(report.passed).toHaveLength(2);
    expect(report.skipped.map((s) => s.entryId)).toEqual(["create-task"]);
  });
});

describe("runConformance cloud executes the surfaced set, skips the rest by name", () => {
  it("runs cloud-surfaced entries against v1 paths, including writes", async () => {
    const seen: Seen[] = [];
    const report = await runConformance(
      [LOCAL_READ, SEEDED_READ, WRITE],
      stubTransport(seen, (c) => {
        if (c.method === "POST") {
          return {
            status: 201,
            body: { id: "n", title: "v1 minimal", status: "todo" },
          };
        }
        if (c.path === "/api/v1/tasks/abc123") {
          return {
            status: 200,
            body: { id: "abc123", title: "t", status: "todo" },
          };
        }
        return { status: 200, body: { tasks: [] } };
      }),
      { surface: "cloud" },
    );
    expect(report.failed).toEqual([]);
    expect(report.passed).toHaveLength(3);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /api/v1/tasks",
      "GET /api/v1/tasks/abc123",
      "POST /api/v1/tasks",
    ]);
    // The write body travels untouched — the runner translates paths, not payloads.
    expect(seen[2]?.body).toEqual({ title: "v1 minimal" });
  });

  it("reports non-cloud entries skipped by name with the manifest reason", async () => {
    const seen: Seen[] = [];
    const report = await runConformance([LOCAL_ONLY, NOWHERE], stubTransport(seen), {
      surface: "cloud",
    });
    expect(seen).toEqual([]);
    expect(report.passed).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toHaveLength(2);
    for (const s of report.skipped) {
      expect(s.detail, `${s.entryId} skip must carry its named reason`).toBeTruthy();
    }
    expect(report.skipped.find((s) => s.entryId === "get-project")?.detail).toBe(
      LOCAL_ONLY.cloudSkipReason,
    );
    expect(report.skipped.find((s) => s.entryId === "mcp-get")?.detail).toBe(
      NOWHERE.cloudSkipReason,
    );
  });

  it("falls back to a phase-and-runnable reason when the manifest names none", async () => {
    const legacy: ManifestEntry = {
      id: "legacy-op",
      v1: { method: "GET", path: "/api/v1/legacy" },
      local: { method: "GET", path: "/api/legacy" },
      runnable: "local-read",
      phase: 0,
      cases: [
        {
          name: "green",
          request: { method: "GET", path: "/api/legacy" },
          expect: { status: 200 },
        },
      ],
    };
    const report = await runConformance([legacy], stubTransport([]), {
      surface: "cloud",
    });
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.detail).toMatch(/phase 0.*runnable=local-read/);
  });

  it("a cloud status mismatch is a failure, never a silent skip", async () => {
    const report = await runConformance(
      [LOCAL_READ],
      stubTransport([], () => ({ status: 400, body: { error: "x", code: "Y" } })),
      { surface: "cloud" },
    );
    expect(report.passed).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.detail).toMatch(/expected status 200, got 400/);
  });
});
