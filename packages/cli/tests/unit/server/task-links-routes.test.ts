/**
 * PATCH /api/tasks/:id links validation — route-level integration tests.
 *
 * Mirrors the verification-routes.test.ts pattern: boot a minimal Express
 * server that mounts only the PATCH handler, create tasks via createTask(),
 * then PATCH with various link payloads and assert HTTP status + payload.
 *
 * All tests run in a temp dir; no real server or MCP involved.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { createServer, type Server } from "node:http";
import {
  ensureTaskDirs,
  createTask,
  updateTask,
  findTaskFilePath,
  listTasks,
  readTaskFile,
} from "../../../src/core/tasks.js";
import { writeConfig } from "../../../src/core/config.js";

// ── Minimal Express app mounting only PATCH /api/tasks/:id ──────────────────

function createPatchOnlyApp(projectDir: string): Server {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const TASK_STATUSES = [
    "backlog",
    "todo",
    "in-progress",
    "review",
    "done",
  ] as const;

  app.patch("/api/tasks/:id", (req, res) => {
    const { id } = req.params;
    const ALLOWED = new Set([
      "status",
      "title",
      "description",
      "type",
      "priority",
      "reportBack",
      "agent",
      "model",
      "tags",
      "sortKey",
      "branchName",
      "links",
    ]);
    const updates = Object.fromEntries(
      Object.entries(req.body as Record<string, unknown>).filter(([k]) =>
        ALLOWED.has(k),
      ),
    );

    if (
      updates.status !== undefined &&
      !(TASK_STATUSES as readonly string[]).includes(updates.status as string)
    ) {
      res.status(400).json({ error: `Invalid status: ${updates.status}` });
      return;
    }

    if (Array.isArray(updates.links)) {
      const linksArr = updates.links as Array<Record<string, unknown>>;
      for (const link of linksArr) {
        if (
          !link ||
          typeof link.taskId !== "string" ||
          link.taskId.length === 0 ||
          typeof link.type !== "string"
        ) {
          res.status(400).json({
            error:
              "Invalid link: each link needs taskId (string) and type (parent|relates|blocks)",
          });
          return;
        }
        if (
          link.type !== "parent" &&
          link.type !== "relates" &&
          link.type !== "blocks"
        ) {
          res.status(400).json({ error: `Invalid link type: ${link.type}` });
          return;
        }
        if (link.type === "parent" && link.taskId === id) {
          res.status(400).json({ error: "Cannot link a task to itself" });
          return;
        }
      }
      // Net-new-only validation (matches real server logic)
      const currentTask = readTaskFile(findTaskFilePath(projectDir, id) ?? "");
      if (currentTask) {
        const existingLinks = currentTask.links ?? [];
        const seenIncoming = new Set<string>();
        for (const link of linksArr) {
          const key = `${String(link.taskId)}::${String(link.type)}`;
          if (seenIncoming.has(key)) {
            res.status(409).json({
              error: `Duplicate link in payload: ${String(link.type)} → ${String(link.taskId)}`,
            });
            return;
          }
          seenIncoming.add(key);
        }
        const existingParent = existingLinks.find((l) => l.type === "parent");
        const incomingParent = linksArr.find(
          (l) => String(l.type) === "parent",
        );
        if (
          existingParent &&
          incomingParent &&
          String(incomingParent.taskId) === existingParent.taskId
        ) {
          // Same parent — no new parent link
        } else if (incomingParent) {
          const allTasks = listTasks(projectDir);
          const visited = new Set<string>();
          let cur = String(incomingParent.taskId);
          let isCycle = false;
          while (!visited.has(cur)) {
            if (cur === id) {
              isCycle = true;
              break;
            }
            visited.add(cur);
            const task = allTasks.find((t) => t.id === cur);
            const parentLink = task?.links?.find((l) => l.type === "parent");
            if (!parentLink) break;
            cur = parentLink.taskId;
          }
          if (isCycle) {
            res.status(409).json({
              error: `Cycle detected: setting parent to ${String(incomingParent.taskId)} would create a circular reference`,
            });
            return;
          }
        }
      }
    }

    const updated = updateTask(projectDir, id, updates);
    if (!updated) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ success: true, task: updated });
  });

  // POST /api/tasks — thin wrapper for creating a task (with link validation)
  app.post("/api/tasks", (req, res) => {
    const { title, description, status, tags, links } = req.body as Record<
      string,
      unknown
    >;
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }

    const validatedLinks = Array.isArray(links)
      ? links
          .filter(
            (l: any) =>
              l &&
              typeof l.taskId === "string" &&
              l.taskId.length > 0 &&
              typeof l.type === "string" &&
              ["parent", "relates", "blocks"].includes(l.type),
          )
          .map((l: any) => ({
            taskId: String(l.taskId),
            type: String(
              l.type,
            ) as import("../../../src/core/types.js").TaskLinkType,
          }))
      : undefined;

    if (validatedLinks) {
      for (const link of validatedLinks) {
        if (link.type === "parent") {
          const targetExists = listTasks(projectDir).some(
            (t) => t.id === link.taskId,
          );
          if (!targetExists) {
            res.status(400).json({
              error: `Parent target task ${link.taskId} not found`,
            });
            return;
          }
        }
      }
    }

    const task = createTask(projectDir, {
      title,
      description: String(description ?? ""),
      status: String(status ?? "todo") as any,
      tags: Array.isArray(tags) ? (tags as string[]) : [],
      links: validatedLinks,
    });
    res.json({ success: true, task });
  });

  return createServer(app);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PATCH /api/tasks/:id — links validation", () => {
  let tempDir: string;
  let server: Server;
  let port: number;
  let parentTaskId: string;
  let childTaskId: string;
  let relatedTaskId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "task-links-routes-"));
    ensureTaskDirs(tempDir);
    writeConfig(tempDir, { mode: "attach", port: 3700 });

    server = createPatchOnlyApp(tempDir);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });

    // Create test tasks via the API
    const parent = await fetchJSON(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Parent task" }),
    });
    parentTaskId = parent.task.id;

    const child = await fetchJSON(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Child task" }),
    });
    childTaskId = child.task.id;

    const related = await fetchJSON(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Related task" }),
    });
    relatedTaskId = related.task.id;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("200: PATCH adds parent link → persisted to disk", async () => {
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          links: [{ taskId: parentTaskId, type: "parent" }],
        }),
      },
    );
    expect(res.success).toBe(true);

    // Verify on disk
    const filePath = findTaskFilePath(tempDir, childTaskId);
    expect(filePath).not.toBeNull();
    const onDisk = JSON.parse(
      (await import("node:fs")).readFileSync(filePath!, "utf-8"),
    );
    expect(onDisk.links).toEqual([{ taskId: parentTaskId, type: "parent" }]);
  });

  it("400: PATCH with missing type field", async () => {
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          links: [{ taskId: parentTaskId }],
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(res.error).toContain("Invalid link");
  });

  it("400: PATCH with bad link type", async () => {
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          links: [{ taskId: parentTaskId, type: "invalid-type" }],
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(res.error).toContain("Invalid link type");
  });

  it("400: PATCH self-parent link", async () => {
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          links: [{ taskId: childTaskId, type: "parent" }],
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(res.error).toContain("itself");
  });

  it("200: PATCH re-applying same links is idempotent", async () => {
    // First add
    await fetchJSON(`http://localhost:${port}/api/tasks/${childTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        links: [{ taskId: parentTaskId, type: "parent" }],
      }),
    });

    // Re-apply the exact same links — should succeed (net-new-only validation)
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          links: [{ taskId: parentTaskId, type: "parent" }],
        }),
      },
    );
    expect(res.success).toBe(true);
  });

  it("200: PATCH parent swap replaces old parent with new parent", async () => {
    // Set parent first
    await fetchJSON(`http://localhost:${port}/api/tasks/${childTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        links: [{ taskId: parentTaskId, type: "parent" }],
      }),
    });

    // Create another task to be the new parent
    const other = await fetchJSON(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Another parent" }),
    });

    // PATCH replaces the parent: old → new (full-replace semantics)
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          links: [{ taskId: other.task.id, type: "parent" }],
        }),
      },
    );
    expect(res.success).toBe(true);

    const filePath = findTaskFilePath(tempDir, childTaskId)!;
    const onDisk = JSON.parse(
      (await import("node:fs")).readFileSync(filePath, "utf-8"),
    );
    expect(onDisk.links).toEqual([{ taskId: other.task.id, type: "parent" }]);
  });

  it("409: PATCH cycle A→B→A", async () => {
    // Set childTaskId's parent = parentTaskId
    await fetchJSON(`http://localhost:${port}/api/tasks/${childTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        links: [{ taskId: parentTaskId, type: "parent" }],
      }),
    });

    // Try to set parentTaskId's parent = childTaskId (cycle)
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${parentTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          links: [{ taskId: childTaskId, type: "parent" }],
        }),
      },
    );
    expect(res.status).toBe(409);
    expect(res.error).toContain("circular");
  });

  it("200: PATCH with empty links array clears existing links", async () => {
    // Set parent first
    await fetchJSON(`http://localhost:${port}/api/tasks/${childTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        links: [{ taskId: parentTaskId, type: "parent" }],
      }),
    });

    // Clear by PATCHing with empty array
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ links: [] }),
      },
    );
    expect(res.success).toBe(true);

    // Verify cleared on disk
    const filePath = findTaskFilePath(tempDir, childTaskId)!;
    const onDisk = JSON.parse(
      (await import("node:fs")).readFileSync(filePath, "utf-8"),
    );
    // Empty array is accepted and stored; the server's PATCH replaces links
    // entirely with the provided array. Empty means "clear all links".
    expect(onDisk.links).toEqual([]);
  });

  it("200: PATCH adds second link (relates) to task that already has parent", async () => {
    // Set parent first
    await fetchJSON(`http://localhost:${port}/api/tasks/${childTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        links: [{ taskId: parentTaskId, type: "parent" }],
      }),
    });

    // Add a relates link — parent stays, relates is net-new
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          links: [
            { taskId: parentTaskId, type: "parent" },
            { taskId: relatedTaskId, type: "relates" },
          ],
        }),
      },
    );
    expect(res.success).toBe(true);

    const filePath = findTaskFilePath(tempDir, childTaskId)!;
    const onDisk = JSON.parse(
      (await import("node:fs")).readFileSync(filePath, "utf-8"),
    );
    expect(onDisk.links).toHaveLength(2);
    expect(onDisk.links).toEqual(
      expect.arrayContaining([
        { taskId: parentTaskId, type: "parent" },
        { taskId: relatedTaskId, type: "relates" },
      ]),
    );
  });

  it("200: PATCH parent swap (old parent → new parent)", async () => {
    // Set parent=A
    await fetchJSON(`http://localhost:${port}/api/tasks/${childTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        links: [{ taskId: parentTaskId, type: "parent" }],
      }),
    });

    // Create a new target for parent swap
    const newParent = await fetchJSON(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "New parent" }),
    });

    // Swap parent: A → B (full-replace semantics)
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          links: [{ taskId: newParent.task.id, type: "parent" }],
        }),
      },
    );
    expect(res.success).toBe(true);

    const filePath = findTaskFilePath(tempDir, childTaskId)!;
    const onDisk = JSON.parse(
      (await import("node:fs")).readFileSync(filePath, "utf-8"),
    );
    expect(onDisk.links).toEqual([
      { taskId: newParent.task.id, type: "parent" },
    ]);
  });

  it("200: two relates links via PATCH (net-new-only validation)", async () => {
    // PATCH with relates link
    await fetchJSON(`http://localhost:${port}/api/tasks/${childTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        links: [{ taskId: relatedTaskId, type: "relates" }],
      }),
    });

    // Add a second relates link to a different target
    const other = await fetchJSON(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Also related" }),
    });

    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          links: [
            { taskId: relatedTaskId, type: "relates" },
            { taskId: other.task.id, type: "relates" },
          ],
        }),
      },
    );
    // Net-new-only: first relates link is retained (idempotent),
    // second is net-new. Both pass validation → 200.
    expect(res.success).toBe(true);

    const filePath = findTaskFilePath(tempDir, childTaskId)!;
    const onDisk = JSON.parse(
      (await import("node:fs")).readFileSync(filePath, "utf-8"),
    );
    expect(onDisk.links).toHaveLength(2);
  });

  it("200: PATCH with unknown keys silently dropped", async () => {
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          title: "Updated title",
          links: [{ taskId: relatedTaskId, type: "relates" }],
          unknownField: "should be dropped",
          anotherUnknown: 42,
        }),
      },
    );
    expect(res.success).toBe(true);

    const filePath = findTaskFilePath(tempDir, childTaskId)!;
    const onDisk = JSON.parse(
      (await import("node:fs")).readFileSync(filePath, "utf-8"),
    );
    expect(onDisk.title).toBe("Updated title");
    expect(onDisk.links).toEqual([{ taskId: relatedTaskId, type: "relates" }]);
    expect(onDisk.unknownField).toBeUndefined();
    expect(onDisk.anotherUnknown).toBeUndefined();
  });

  it("400: PATCH with empty taskId string", async () => {
    const res = await fetchJSON(
      `http://localhost:${port}/api/tasks/${childTaskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          links: [{ taskId: "", type: "parent" }],
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(res.error).toContain("Invalid link");
  });

  it("400: POST with non-existent parent target", async () => {
    const res = await fetchJSON(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: "Task with bad parent",
        selector: "test",
        links: [{ taskId: "nonexistent-id-12345", type: "parent" }],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.error).toContain("not found");
  });

  it("200: POST with valid parent link", async () => {
    const res = await fetchJSON(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: "Task with parent",
        selector: "test",
        links: [{ taskId: parentTaskId, type: "parent" }],
      }),
    });
    expect(res.success).toBe(true);
    expect(res.task.links).toEqual([{ taskId: parentTaskId, type: "parent" }]);
  });

  it("200: POST with empty links array", async () => {
    const res = await fetchJSON(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: "Task with empty links",
        selector: "test",
        links: [],
      }),
    });
    expect(res.success).toBe(true);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJSON(url: string, opts: RequestInit): Promise<any> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await res.json();
  return { ...body, status: res.status };
}
