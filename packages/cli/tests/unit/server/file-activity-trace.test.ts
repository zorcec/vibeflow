/**
 * File add/remove activity traces at the HTTP layer (949e7c0a):
 * POST /files/:filename writes a system "File added" comment and DELETE
 * writes a system "File removed" comment — the same mechanism the removal
 * path has always used — so the activity feed records both. A comment EDIT
 * deliberately leaves no new entry (it would spam); that decision is pinned
 * here so a future change cannot silently start tracing edits.
 *
 * Boots the real API-only server in offline mode (same boot path the kanban
 * board uses), so the assertions cover the actual Express handlers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTask } from "../../../src/core/tasks.js";
import { writeConfig } from "../../../src/core/config.js";

import { serveWithPort } from "../../helpers/serve-with-port.js";
import type { ServeInstance } from "../../../src/server/server.js";

process.env.VIBEFLOW_TELEMETRY = "0";

interface TraceComment {
  id: string;
  text: string;
  type?: string;
}

describe("file activity traces", () => {
  let tempDir: string;
  let instance: ServeInstance;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-filetrace-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
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

  async function getComments(taskId: string): Promise<TraceComment[]> {
    const res = await fetch(`${instance.url}/api/tasks/${taskId}/comments`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { comments: TraceComment[] }).comments;
  }

  it("POST /files/:filename leaves a system 'File added' trace", async () => {
    const task = createTask(tempDir, {
      title: "Trace test",
      description: "",
      status: "todo",
      selector: "/",
    });
    const res = await fetch(
      `${instance.url}/api/tasks/${task.id}/files/notes.md`,
      {
        method: "POST",
        headers: { "Content-Type": "text/markdown" },
        body: "hello",
      },
    );
    expect(res.status).toBe(200);
    const comments = await getComments(task.id);
    const trace = comments.find((c) => c.text.includes("File added"));
    expect(trace).toBeDefined();
    expect(trace!.type).toBe("system");
    expect(trace!.text).toContain("notes.md");
  });

  it("DELETE /files/:filename leaves a system 'File removed' trace", async () => {
    const task = createTask(tempDir, {
      title: "Trace test",
      description: "",
      status: "todo",
      selector: "/",
    });
    const put = await fetch(
      `${instance.url}/api/tasks/${task.id}/files/notes.md`,
      {
        method: "POST",
        headers: { "Content-Type": "text/markdown" },
        body: "hello",
      },
    );
    expect(put.status).toBe(200);
    const del = await fetch(
      `${instance.url}/api/tasks/${task.id}/files/notes.md`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    const comments = await getComments(task.id);
    const trace = comments.find((c) => c.text.includes("File removed"));
    expect(trace).toBeDefined();
    expect(trace!.type).toBe("system");
    expect(trace!.text).toContain("notes.md");
  });

  it("PATCH /comments/:commentId (edit) leaves no new feed entry", async () => {
    const task = createTask(tempDir, {
      title: "Trace test",
      description: "",
      status: "todo",
      selector: "/",
    });
    const posted = await fetch(`${instance.url}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "original", author: "user" }),
    });
    expect(posted.status).toBe(200);
    const { comment } = (await posted.json()) as { comment: TraceComment };
    const before = await getComments(task.id);
    const patched = await fetch(
      `${instance.url}/api/tasks/${task.id}/comments/${comment.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "edited" }),
      },
    );
    expect(patched.status).toBe(200);
    const after = await getComments(task.id);
    // Same count: the edit rewrote the comment in place, no trace added.
    expect(after.length).toBe(before.length);
    expect(after.find((c) => c.id === comment.id)!.text).toContain("edited");
  });
});
