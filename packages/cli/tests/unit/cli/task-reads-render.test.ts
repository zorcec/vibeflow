/**
 * CLI read-renderer contract (ticket d7b9dc13, plan step 6).
 *
 * `src/cli/renderers/task-reads.ts` is the ONLY place list/get output is
 * assembled, and it must never resolve a store on its own: the port rule
 * (no runtime import from the file-backed store modules or the remote
 * client) is asserted statically below, so a future edit that reaches
 * around the ports fails here instead of reintroducing the phantom-record
 * split. The envelope builders are pinned against the established shapes:
 * the local rich-counts list payload, the legacy remote `tasks` +
 * `hiddenChildren` payload, the `task`-keyed get payloads, and the refusal
 * code → exit-code mapping the inline branches used.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskListResult } from "../../../src/core/task-listing.js";
import type { Task } from "../../../src/core/types.js";
import {
  localListJsonPayload,
  remoteListJsonPayload,
  localGetJsonPayload,
  remoteGetJsonPayload,
  operationRefusalEnvelope,
  refusalExitCode,
  pickFields,
  pickPreservingCounts,
} from "../../../src/cli/renderers/task-reads.js";
import { ExitCode } from "../../../src/core/exit-codes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function task(id: string, extra: Record<string, unknown> = {}): Task {
  return {
    id,
    title: `title ${id}`,
    description: "",
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    ...extra,
  } as Task;
}

function listResult(rows: Task[]): TaskListResult {
  return {
    tasks: rows,
    totalMatching: rows.length,
    totalRoots: rows.length,
    hiddenChildren: 0,
    returned: rows.length,
    limit: 20,
    truncated: false,
    offset: 0,
    remaining: 0,
    nextCursor: null,
    order: ["status", "priority", "updated", "id"],
  };
}

describe("renderer port rule — no store of its own", () => {
  it("task-reads.ts has no runtime import from storage or the remote client", () => {
    const src = readFileSync(
      join(__dirname, "../../../src/cli/renderers/task-reads.ts"),
      "utf-8",
    );
    const banned = [
      "core/tasks.js",
      "core/comments.js",
      "core/files.js",
      "saas/client.js",
      "core/task-store.js",
      "core/remote-task-store.js",
      "core/operation-context.js",
    ];
    const offenders: string[] = [];
    for (const line of src.split("\n")) {
      const trimmed = line.trim();
      // Type-only imports are erased at runtime and cannot touch a store;
      // comments are prose, not dependencies — only real runtime imports
      // (import … from / export … from / await import(…)) can reach a store.
      if (trimmed.startsWith("import type")) continue;
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      const isRuntimeImport =
        /\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]/.test(trimmed) ||
        /\bexport\s+(?:[^'"]*?\sfrom\s+)['"]/.test(trimmed) ||
        /\bawait\s+import\s*\(/.test(trimmed);
      if (!isRuntimeImport) continue;
      for (const mod of banned) {
        if (trimmed.includes(mod)) offenders.push(`${mod}: ${trimmed}`);
      }
    }
    expect(
      offenders,
      `renderer reaches around the ports: ${offenders.join("; ")}`,
    ).toEqual([]);
  });
});

describe("list envelopes", () => {
  it("local payload carries the full counts vocabulary", () => {
    const payload = localListJsonPayload(
      { ...listResult([task("a")]), totalMatching: 5, totalRoots: 3, hiddenChildren: 2 },
      [],
    );
    expect(payload.tasks).toHaveLength(1);
    expect(payload.totalMatching).toBe(5);
    expect(payload.totalRoots).toBe(3);
    expect(payload.hiddenChildren).toBe(2);
    expect(payload.limit).toBe(20);
    expect(payload.truncated).toBe(false);
    expect(payload.offset).toBe(0);
    expect(payload.remaining).toBe(0);
    expect(payload.nextCursor).toBeNull();
    expect(payload.order).toEqual(["status", "priority", "updated", "id"]);
    expect("limitNotice" in payload).toBe(false);
    expect("hint" in payload).toBe(false);
  });

  it("local payload surfaces limitNotice and hint when the model reports them", () => {
    const payload = localListJsonPayload(
      {
        ...listResult([task("a")]),
        limitNotice: "limit 0 is not supported — applied the default of 20",
        truncated: true,
        hint: "showing 1 of 3 matching",
      },
      [],
    );
    expect(payload.limitNotice).toContain("limit 0");
    expect(payload.hint).toContain("showing 1 of 3");
  });

  it("local projections keep the operation-attached counts, never silent zeros", () => {
    const payload = localListJsonPayload(
      listResult([task("a", { commentCount: 2, fileCount: 1 } as never)]),
      ["id"],
    );
    const row = (payload.tasks as Array<Record<string, unknown>>)[0];
    expect(row.id).toBe("a");
    expect(row.title).toBeUndefined();
    expect(row.commentCount).toBe(2);
    expect(row.fileCount).toBe(1);
  });

  it("pickPreservingCounts drops unknown fields but keeps carried counts", () => {
    expect(pickPreservingCounts({ id: "a", x: 1 }, ["id", "nope"])).toEqual({
      id: "a",
    });
    expect(
      pickPreservingCounts(
        { id: "a", commentCount: 3, fileCount: 0 },
        ["id"],
      ),
    ).toEqual({ id: "a", commentCount: 3, fileCount: 0 });
  });

  it("remote payload keeps the legacy tasks + hiddenChildren envelope", () => {
    const payload = remoteListJsonPayload(
      { ...listResult([task("a"), task("b")]), hiddenChildren: 1 },
      [],
    );
    expect(Object.keys(payload).sort()).toEqual([
      "hiddenChildren",
      "tasks",
    ]);
    expect((payload.tasks as Task[]).map((t) => t.id)).toEqual(["a", "b"]);
    expect(payload.hiddenChildren).toBe(1);
  });

  it("remote projections pass operation rows through with no invented counts", () => {
    const payload = remoteListJsonPayload(
      {
        ...listResult([
          task("a", { commentCount: 4, fileCount: 0 } as never),
        ]),
        hiddenChildren: 0,
      },
      ["id"],
    );
    const row = (payload.tasks as Array<Record<string, unknown>>)[0];
    expect(row).toEqual({ id: "a" });
  });
});

describe("get envelopes", () => {
  it("local get nests the task with its ports-supplied arrays under `task`", () => {
    const payload = localGetJsonPayload(task("a"), [], {
      comments: [{ author: "agent", text: "hi" }],
      files: [{ name: "a.md" }],
    });
    const nested = payload.task as Record<string, unknown>;
    expect(nested.id).toBe("a");
    expect(nested.comments).toHaveLength(1);
    expect(nested.files).toHaveLength(1);
  });

  it("local get projections keep only named fields plus carried counts", () => {
    const payload = localGetJsonPayload(
      task("a", { commentCount: 2, fileCount: 0 } as never),
      ["id", "title"],
      { comments: [], files: [] },
    );
    expect(payload.task).toEqual({
      id: "a",
      title: "title a",
      commentCount: 2,
      fileCount: 0,
    });
  });

  it("remote get passes the operation task through under `task`", () => {
    const payload = remoteGetJsonPayload(
      task("a", { parentId: "p" } as never),
      [],
    );
    expect((payload.task as Record<string, unknown>).id).toBe("a");
    expect((payload.task as Record<string, unknown>).parentId).toBe("p");
  });
});

describe("refusals", () => {
  it("operation errors forward verbatim (no relabelling)", () => {
    expect(
      operationRefusalEnvelope({
        code: "E_BACKEND_UNAVAILABLE",
        message: "Online board read failed (network): fetch failed",
        suggestion: "Check the backend is reachable and retry the read.",
        retryable: true,
      }),
    ).toEqual({
      ok: false,
      code: "E_BACKEND_UNAVAILABLE",
      message: "Online board read failed (network): fetch failed",
      suggestion: "Check the backend is reachable and retry the read.",
      retryable: true,
    });
    // Optional arms stay absent when the operation sets none.
    expect(
      operationRefusalEnvelope({ code: "TASK_NOT_FOUND", message: "nope" }),
    ).toEqual({ ok: false, code: "TASK_NOT_FOUND", message: "nope" });
  });

  it("exit codes match the historical inline mapping", () => {
    expect(refusalExitCode("TASK_NOT_FOUND")).toBe(ExitCode.NOT_FOUND);
    expect(refusalExitCode("E_AMBIGUOUS")).toBe(ExitCode.USAGE);
    expect(refusalExitCode("E_USAGE")).toBe(ExitCode.USAGE);
    expect(refusalExitCode("E_BACKEND_UNAVAILABLE")).toBe(ExitCode.GENERAL);
    expect(refusalExitCode("E_NOT_AUTHENTICATED")).toBe(ExitCode.GENERAL);
    expect(refusalExitCode("LIST_TASKS_ERROR")).toBe(ExitCode.GENERAL);
  });

  it("pickFields with no fields returns a copy, unknown fields are dropped", () => {
    const t = { id: "a", title: "t" };
    expect(pickFields(t, [])).toEqual(t);
    expect(pickFields(t, [])).not.toBe(t);
    expect(pickFields({ ...t, x: 1 }, ["id", "nope"])).toEqual({ id: "a" });
  });
});
