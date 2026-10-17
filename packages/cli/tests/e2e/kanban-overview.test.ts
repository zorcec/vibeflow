/**
 * E2E: the overview route (ticket 717d6335).
 *
 * - GET /overview serves 200 HTML with the SAME inlined shell as /kanban
 *   (single-file packaging: no second asset — byte-identical bodies prove
 *   the bundle pipeline was reused, not forked).
 * - Both responses carry `Cache-Control: no-store` (inlined bundle would
 *   otherwise outlive a restart from a cached copy).
 * - The seeded-board numbers are asserted through the shared pure
 *   aggregator over the live GET /api/tasks payload: the exact counts pin
 *   the seed, so a wrong seed goes red here too.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWithPort } from "../helpers/serve-with-port.js";
import type { ServeInstance } from "../../src/server/server.js";
import { computeBoardOverview } from "../../src/client/kanban/overview.js";
import type { Task } from "@vibeflow-tools/ui/kanban";

process.env.VIBEFLOW_TELEMETRY = "0";

async function createTask(
  base: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
  const data = (await res.json()) as { task: { id: string } };
  return { id: data.task.id };
}

describe("kanban overview route", () => {
  let tempDir: string;
  let instance: ServeInstance | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kanban-overview-e2e-"));
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("GET /overview serves 200 with the same shell as /kanban and no-store", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir: tempDir,
      // @internal test hooks — force OFFLINE mode so the shell is served
      _testToken: null,
      _testWorkspace: null,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const [overviewRes, kanbanRes] = await Promise.all([
        fetch(`${instance.url}/overview`, { signal: controller.signal }),
        fetch(`${instance.url}/kanban`, { signal: controller.signal }),
      ]);
      expect(overviewRes.status).toBe(200);
      expect(kanbanRes.status).toBe(200);
      expect(overviewRes.headers.get("content-type")).toContain("text/html");
      expect(overviewRes.headers.get("cache-control")).toBe("no-store");
      expect(kanbanRes.headers.get("cache-control")).toBe("no-store");
      const [overviewHtml, kanbanHtml] = await Promise.all([
        overviewRes.text(),
        kanbanRes.text(),
      ]);
      // Same inlined bundle + CSS + shell: the overview reuses the board
      // pipeline instead of shipping a second asset.
      expect(overviewHtml).toBe(kanbanHtml);
      expect(overviewHtml).toContain('id="root"');
    } finally {
      clearTimeout(timer);
    }
  });

  it("aggregates over the live task API match the seeded board exactly", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir: tempDir,
      _testToken: null,
      _testWorkspace: null,
    });

    // Seed: 1 backlog, 2 todo, 1 in-progress, 1 done-today.
    await createTask(instance.url, {
      title: "overview backlog",
      selector: "/a",
      status: "backlog",
    });
    await createTask(instance.url, {
      title: "overview todo one",
      selector: "/b",
      status: "todo",
    });
    await createTask(instance.url, {
      title: "overview todo two",
      selector: "/c",
      status: "todo",
    });
    const wip = await createTask(instance.url, {
      title: "overview wip",
      selector: "/d",
      status: "todo",
    });
    await fetch(`${instance.url}/api/tasks/${wip.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in-progress" }),
    });
    const doneSeed = await createTask(instance.url, {
      title: "overview done",
      selector: "/e",
      status: "todo",
    });
    await fetch(`${instance.url}/api/tasks/${doneSeed.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const listRes = await fetch(`${instance.url}/api/tasks`, {
        signal: controller.signal,
      });
      expect(listRes.ok).toBe(true);
      const { tasks } = (await listRes.json()) as { tasks: Task[] };
      expect(tasks).toHaveLength(5);

      // The overview page aggregates THIS payload client-side — pinning the
      // exact numbers here keeps a wrong seed red at the route level.
      const o = computeBoardOverview(tasks);
      expect(o.total).toBe(5);
      expect(o.countsByStatus).toEqual({
        backlog: 1,
        todo: 2,
        "in-progress": 1,
        review: 0,
        done: 1,
      });
      expect(o.doneToday).toBe(1);
      expect(o.doneThisWeek).toBe(1);
      expect(o.oldestTodo?.title).toBe("overview todo one");
      expect(o.oldestInProgress?.title).toBe("overview wip");
    } finally {
      clearTimeout(timer);
    }
  });
});
