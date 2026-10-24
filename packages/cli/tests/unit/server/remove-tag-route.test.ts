/**
 * Local bulk tag-removal endpoint (`POST /api/tasks/remove-tag`).
 *
 * Boots the real API-only server in offline mode (same boot path the kanban
 * board uses, same pattern as the CORS suite), so the assertions cover the
 * actual Express route rather than a copy of it: the request shape
 * `{ tag }`, the `{ removed }` response, refresh-friendly success semantics
 * (exactly one `tasks-updated` broadcast happens server-side; the client
 * reloads on success and never optimistically), and byte-identical stores
 * on rejected input.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTask, listTasksWithPaths } from "../../../src/core/tasks.js";
import { writeConfig } from "../../../src/core/config.js";

import { serveWithPort } from "../../helpers/serve-with-port.js";
import type { ServeInstance } from "../../../src/server/server.js";

process.env.VIBEFLOW_TELEMETRY = "0";

describe("POST /api/tasks/remove-tag (uvbpv6ax)", () => {
  let tempDir: string;
  let instance: ServeInstance;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-remove-tag-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    createTask(tempDir, {
      title: "Tagged one",
      description: "",
      status: "todo",
      tags: ["bulk-me", "keep"],
    });
    createTask(tempDir, {
      title: "Tagged two",
      description: "",
      status: "todo",
      tags: ["bulk-me"],
    });
    createTask(tempDir, {
      title: "Untagged",
      description: "",
      status: "todo",
      tags: ["other"],
    });
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir: tempDir,
      // @internal test hooks — force OFFLINE mode so local task routes mount
      _testToken: null,
      _testWorkspace: null,
    });
  });

  afterEach(async () => {
    await instance.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function snapshot(): string[] {
    return listTasksWithPaths(tempDir)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => readFileSync(t.filePath, "utf-8"));
  }

  async function postRemoveTag(body: unknown): Promise<Response> {
    return fetch(`${instance.url}/api/tasks/remove-tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("removes the tag from every matching task and reports the count", async () => {
    const res = await postRemoveTag({ tag: "bulk-me" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 2 });

    const rows = listTasksWithPaths(tempDir);
    expect(
      rows.filter((t) => (t.tags ?? []).includes("bulk-me")),
    ).toEqual([]);
    expect(
      rows.find((t) => t.title === "Tagged one")?.tags,
    ).toEqual(["keep"]);
    expect(
      rows.find((t) => t.title === "Untagged")?.tags,
    ).toEqual(["other"]);
  });

  it("reports zero removals for an unknown tag without touching the store", async () => {
    const before = snapshot();
    const res = await postRemoveTag({ tag: "no-such-tag" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 0 });
    expect(snapshot()).toEqual(before);
  });

  it.each([{}, { tag: "" }, { tag: "   " }, { tag: null }])(
    "rejects invalid payload %j with 400 and leaves the store byte-identical",
    async (body) => {
      const before = snapshot();
      const res = await postRemoveTag(body);
      expect(res.status).toBe(400);
      expect(snapshot()).toEqual(before);
    },
  );
});
