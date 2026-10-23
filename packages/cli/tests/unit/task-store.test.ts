import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalTaskStore } from "../../src/core/task-store.js";
import * as tasksModule from "../../src/core/tasks.js";
import * as commentsModule from "../../src/core/comments.js";
import * as filesModule from "../../src/core/files.js";
import { listTasks } from "../../src/core/tasks.js";

/**
 * P1 (ticket 3d613068): LocalTaskStore delegates 1:1 to the existing
 * synchronous file-backed functions — same return values, same errors, same
 * mutations — behind Promise-returning ports. A spy on each underlying
 * module proves the delegation; behaviour suites (tasks/comments/files)
 * lock the behaviour itself.
 *
 * Settling is asserted, not assumed: every write below is followed by a
 * dependent read through the SAME port, so returning the pre-write snapshot
 * (or forgetting an `await` in the adapter) fails the suite.
 */
function makeTaskInput(title = "store task") {
  return {
    title,
    description: "delegation probe",
    status: "todo" as const,
    selector: "/",
  };
}

describe("LocalTaskStore delegation", () => {
  let dir: string;
  let store: LocalTaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vibeflow-task-store-"));
    store = new LocalTaskStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("every port method returns a real Promise", async () => {
    const created = await store.createTask(dir, makeTaskInput());
    expect(store.listTasks(dir)).toBeInstanceOf(Promise);
    expect(store.getTask(dir, created.id)).toBeInstanceOf(Promise);
    expect(store.resolveTask(dir, created.id)).toBeInstanceOf(Promise);
    expect(
      store.updateTask(dir, created.id, { title: "x" }),
    ).toBeInstanceOf(Promise);
    expect(store.listComments(dir, created.id)).toBeInstanceOf(Promise);
    expect(store.listFiles(dir, created.id)).toBeInstanceOf(Promise);
    expect(store.getFileCount(dir, created.id)).toBeInstanceOf(Promise);
    expect(store.previewClaim(dir)).toBeInstanceOf(Promise);
    expect(store.claimNextTaskAtomic(dir)).toBeInstanceOf(Promise);
    expect(
      store.validateAttachment(dir, "note.md", 3),
    ).toBeInstanceOf(Promise);
  });

  it("createTask delegates and the write settles before a dependent read", async () => {
    const spy = vi.spyOn(tasksModule, "createTask");
    const input = makeTaskInput();
    const viaStore = await store.createTask(dir, input);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(dir, input);
    expect(viaStore.title).toBe("store task");
    // Same mutation as the underlying function, visible to a dependent read
    // through the SAME port (a pre-write snapshot would miss the id).
    const reread = await store.getTask(dir, viaStore.id);
    expect(reread).toMatchObject({ id: viaStore.id });
    expect(listTasks(dir).map((t) => t.id)).toContain(viaStore.id);
  });

  it("listTasks delegates with identical values and forwards read findings", async () => {
    await store.createTask(dir, makeTaskInput("a"));
    await store.createTask(dir, makeTaskInput("b"));
    const direct = tasksModule.listTasks(dir);
    const spy = vi.spyOn(tasksModule, "listTasks");
    const viaStore = await store.listTasks(dir);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(dir, undefined);
    expect(viaStore).toEqual(direct);
  });

  it("getTask delegates to findTaskByIdOrPrefix, including prefix + miss", async () => {
    const created = await store.createTask(dir, makeTaskInput());
    const spy = vi.spyOn(tasksModule, "findTaskByIdOrPrefix");
    expect(await store.getTask(dir, created.id))?.toMatchObject({
      id: created.id,
    });
    expect(await store.getTask(dir, created.id.slice(0, 8)))?.toMatchObject({
      id: created.id,
    });
    expect(spy).toHaveBeenCalledWith(dir, created.id.slice(0, 8));
    // Same miss behaviour as the underlying function.
    expect(await store.getTask(dir, "nope-missing")).toBeUndefined();
    expect(tasksModule.findTaskByIdOrPrefix(dir, "nope-missing")).toBeUndefined();
  });

  it("resolveTask distinguishes found, missing and unreadable", async () => {
    const created = await store.createTask(dir, makeTaskInput());
    const found = await store.resolveTask(dir, created.id.slice(0, 8));
    expect(found.status).toBe("found");
    if (found.status === "found") {
      expect(found.id).toBe(created.id);
      expect(found.task.id).toBe(created.id);
    }
    const missing = await store.resolveTask(dir, "nope-missing");
    expect(missing).toEqual({ status: "missing", id: "nope-missing" });

    // Corrupt the record in place: the file exists but does not parse.
    const { writeFileSync } = await import("node:fs");
    const { findTaskFilePath } = tasksModule;
    writeFileSync(findTaskFilePath(dir, created.id)!, "{not json");
    const unreadable = await store.resolveTask(dir, created.id);
    expect(unreadable.status).toBe("unreadable");
    if (unreadable.status === "unreadable") {
      expect(unreadable.id).toBe(created.id);
    }
  });

  it("updateTask delegates and returns the post-write snapshot, not the pre-write one", async () => {
    const created = await store.createTask(dir, makeTaskInput());
    const spy = vi.spyOn(tasksModule, "updateTask");
    const updates = { status: "in-progress" as const };
    const viaStore = await store.updateTask(dir, created.id, updates);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(dir, created.id, updates);
    // The returned record must carry the write (mutation: return the
    // pre-write snapshot and this fails), and a dependent read agrees.
    expect(viaStore)?.toMatchObject({ id: created.id, status: "in-progress" });
    expect(await store.getTask(dir, created.id))?.toMatchObject({
      status: "in-progress",
    });
    // Same error value as calling the underlying function on a miss.
    expect(await store.updateTask(dir, "missing-id", updates)).toBeNull();
    expect(tasksModule.updateTask(dir, "missing-id", updates)).toBeNull();
  });

  it("deleteTask delegates with the same boolean + mutation", async () => {
    const created = await store.createTask(dir, makeTaskInput());
    const spy = vi.spyOn(tasksModule, "deleteTask");
    expect(await store.deleteTask(dir, created.id)).toBe(true);
    expect(spy).toHaveBeenCalledWith(dir, created.id);
    expect(listTasks(dir).map((t) => t.id)).not.toContain(created.id);
    // Same miss value as the underlying function.
    expect(await store.deleteTask(dir, "missing-id")).toBe(false);
    expect(tasksModule.deleteTask(dir, "missing-id")).toBe(false);
  });

  it("comment methods delegate with identical values", async () => {
    const created = await store.createTask(dir, makeTaskInput());
    const listSpy = vi.spyOn(commentsModule, "listComments");
    expect(await store.listComments(dir, created.id)).toEqual([]);
    expect(listSpy).toHaveBeenCalledWith(dir, created.id);

    const addSpy = vi.spyOn(commentsModule, "addComment");
    const comment = await store.addComment(dir, created.id, "user", "hello");
    expect(addSpy).toHaveBeenCalledWith(
      dir,
      created.id,
      "user",
      "hello",
      undefined,
      undefined,
      undefined,
    );
    expect(comment.text).toBe("hello");
    // The write settles before the dependent list (fire-and-forget would
    // leave this empty).
    expect(
      (await store.listComments(dir, created.id)).map((c) => c.id),
    ).toContain(comment.id);

    const updateSpy = vi.spyOn(commentsModule, "updateComment");
    const updated = await store.updateComment(
      dir,
      created.id,
      comment.id,
      "edited",
    );
    expect(updateSpy).toHaveBeenCalledWith(dir, created.id, comment.id, "edited");
    expect(updated?.text).toBe("edited");
    // Same miss value as the underlying function.
    expect(
      await store.updateComment(dir, created.id, "missing", "x"),
    ).toBeNull();

    const deleteSpy = vi.spyOn(commentsModule, "deleteComment");
    expect(await store.deleteComment(dir, created.id, comment.id)).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith(dir, created.id, comment.id);
    expect(await store.deleteComment(dir, created.id, comment.id)).toBe(false);
  });

  it("file methods delegate with identical values and mutations", async () => {
    const created = await store.createTask(dir, makeTaskInput());
    const data = Buffer.from("bytes");
    const saveSpy = vi.spyOn(filesModule, "saveFile");
    const saved = await store.saveFile(dir, created.id, "note.txt", data);
    expect(saveSpy).toHaveBeenCalledWith(
      dir,
      created.id,
      "note.txt",
      data,
      undefined,
    );
    expect(saved.name).toBe("note.txt");

    const listSpy = vi.spyOn(filesModule, "listFiles");
    expect(
      (await store.listFiles(dir, created.id)).map((f) => f.name),
    ).toContain("note.txt");
    expect(listSpy).toHaveBeenCalledWith(dir, created.id);
    expect(await store.listFiles(dir, created.id)).toEqual(
      filesModule.listFiles(dir, created.id),
    );

    expect(store.getFilePath(dir, created.id, "note.txt")).toBe(
      filesModule.getFilePath(dir, created.id, "note.txt"),
    );
    expect(await store.getFileCount(dir, created.id)).toBe(
      filesModule.getFileCount(dir, created.id),
    );

    const deleteSpy = vi.spyOn(filesModule, "deleteFile");
    expect(await store.deleteFile(dir, created.id, "note.txt")).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith(dir, created.id, "note.txt");
    expect(await store.listFiles(dir, created.id)).toEqual([]);
    expect(await store.deleteFile(dir, created.id, "missing.txt")).toBe(false);
  });

  it("validateAttachment enforces the local filename policy", async () => {
    expect(
      await store.validateAttachment(dir, "note.md", 3),
    ).toMatchObject({ valid: true });
    const refused = await store.validateAttachment(dir, "evil.exe", 3);
    expect(refused.valid).toBe(false);
    expect(refused.errorCode).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("claimNextTaskAtomic delegates to the locked primitive and writes the claim", async () => {
    const spy = vi.spyOn(tasksModule, "claimNextTaskAtomic");
    await store.createTask(dir, makeTaskInput("claimable"));
    const claimed = await store.claimNextTaskAtomic(dir, { rootsOnly: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(dir, { rootsOnly: true });
    expect(claimed?.title).toBe("claimable");
    // The claim is settled: a dependent read sees in-progress, so a second
    // atomic claim cannot take the same task.
    expect(await store.getTask(dir, claimed!.id))?.toMatchObject({
      status: "in-progress",
    });
    expect(await store.claimNextTaskAtomic(dir)).toBeNull();
  });

  it("previewClaim names the live claim's candidate and writes nothing", async () => {
    await store.createTask(dir, {
      ...makeTaskInput("low"),
      priority: "Low" as const,
    });
    const high = await store.createTask(dir, {
      ...makeTaskInput("high"),
      priority: "High" as const,
    });
    const preview = await store.previewClaim(dir);
    expect(preview?.task.id).toBe(high.id);
    expect(preview?.childClaim).toBe(false);
    // Read-only: the candidate is still todo after the preview.
    expect(await store.getTask(dir, high.id))?.toMatchObject({
      status: "todo",
    });
    const live = await store.claimNextTaskAtomic(dir);
    expect(live?.id).toBe(preview?.task.id);
  });
});
