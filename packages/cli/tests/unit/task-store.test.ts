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
 * P1 (ticket 7339393c): LocalTaskStore must delegate 1:1 to the existing
 * file-backed functions — same return values, same errors, same mutations.
 * A spy on each underlying module proves the delegation; behaviour suites
 * (tasks/comments/files) lock the behaviour itself.
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

  it("createTask delegates and persists the same mutation", () => {
    const spy = vi.spyOn(tasksModule, "createTask");
    const input = makeTaskInput();
    const viaStore = store.createTask(dir, input);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(dir, input);
    expect(viaStore.title).toBe("store task");
    // Same mutation as the underlying function: visible via a direct read.
    expect(listTasks(dir).map((t) => t.id)).toContain(viaStore.id);
  });

  it("listTasks delegates with identical return values", () => {
    store.createTask(dir, makeTaskInput("a"));
    store.createTask(dir, makeTaskInput("b"));
    const direct = tasksModule.listTasks(dir);
    const spy = vi.spyOn(tasksModule, "listTasks");
    const viaStore = store.listTasks(dir);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(dir, undefined);
    expect(viaStore).toEqual(direct);
  });

  it("getTask delegates to findTaskByIdOrPrefix, including prefix + miss", () => {
    const created = store.createTask(dir, makeTaskInput());
    const spy = vi.spyOn(tasksModule, "findTaskByIdOrPrefix");
    expect(store.getTask(dir, created.id))?.toMatchObject({ id: created.id });
    expect(store.getTask(dir, created.id.slice(0, 8)))?.toMatchObject({
      id: created.id,
    });
    expect(spy).toHaveBeenCalledWith(dir, created.id.slice(0, 8));
    // Same miss behaviour as the underlying function.
    expect(store.getTask(dir, "nope-missing")).toBeUndefined();
    expect(tasksModule.findTaskByIdOrPrefix(dir, "nope-missing")).toBeUndefined();
  });

  it("updateTask delegates and returns the same value + error (null on miss)", () => {
    const created = store.createTask(dir, makeTaskInput());
    const spy = vi.spyOn(tasksModule, "updateTask");
    const updates = { status: "in-progress" as const };
    const viaStore = store.updateTask(dir, created.id, updates);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(dir, created.id, updates);
    expect(viaStore)?.toMatchObject({ id: created.id, status: "in-progress" });
    // Same error value as calling the underlying function on a miss.
    expect(store.updateTask(dir, "missing-id", updates)).toBeNull();
    expect(tasksModule.updateTask(dir, "missing-id", updates)).toBeNull();
  });

  it("deleteTask delegates with the same boolean + mutation", () => {
    const created = store.createTask(dir, makeTaskInput());
    const spy = vi.spyOn(tasksModule, "deleteTask");
    expect(store.deleteTask(dir, created.id)).toBe(true);
    expect(spy).toHaveBeenCalledWith(dir, created.id);
    expect(listTasks(dir).map((t) => t.id)).not.toContain(created.id);
    // Same miss value as the underlying function.
    expect(store.deleteTask(dir, "missing-id")).toBe(false);
    expect(tasksModule.deleteTask(dir, "missing-id")).toBe(false);
  });

  it("comment methods delegate with identical values", async () => {
    const created = store.createTask(dir, makeTaskInput());
    const listSpy = vi.spyOn(commentsModule, "listComments");
    expect(store.listComments(dir, created.id)).toEqual([]);
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
    expect(store.listComments(dir, created.id).map((c) => c.id)).toContain(
      comment.id,
    );

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
    expect(await store.updateComment(dir, created.id, "missing", "x")).toBeNull();

    const deleteSpy = vi.spyOn(commentsModule, "deleteComment");
    expect(await store.deleteComment(dir, created.id, comment.id)).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith(dir, created.id, comment.id);
    expect(await store.deleteComment(dir, created.id, comment.id)).toBe(false);
  });

  it("file methods delegate with identical values and mutations", () => {
    const created = store.createTask(dir, makeTaskInput());
    const data = Buffer.from("bytes");
    const saveSpy = vi.spyOn(filesModule, "saveFile");
    const saved = store.saveFile(dir, created.id, "note.txt", data);
    expect(saveSpy).toHaveBeenCalledWith(
      dir,
      created.id,
      "note.txt",
      data,
      undefined,
    );
    expect(saved.name).toBe("note.txt");

    const listSpy = vi.spyOn(filesModule, "listFiles");
    expect(store.listFiles(dir, created.id).map((f) => f.name)).toContain(
      "note.txt",
    );
    expect(listSpy).toHaveBeenCalledWith(dir, created.id);
    expect(store.listFiles(dir, created.id)).toEqual(
      filesModule.listFiles(dir, created.id),
    );

    expect(store.getFilePath(dir, created.id, "note.txt")).toBe(
      filesModule.getFilePath(dir, created.id, "note.txt"),
    );
    expect(store.getFileCount(dir, created.id)).toBe(
      filesModule.getFileCount(dir, created.id),
    );

    const deleteSpy = vi.spyOn(filesModule, "deleteFile");
    expect(store.deleteFile(dir, created.id, "note.txt")).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith(dir, created.id, "note.txt");
    expect(store.listFiles(dir, created.id)).toEqual([]);
    expect(store.deleteFile(dir, created.id, "missing.txt")).toBe(false);
  });
});
