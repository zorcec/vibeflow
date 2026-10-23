/**
 * Portable operation boundary (ticket 3d613068).
 *
 * A fake in-memory `TaskStore` with DELAYED async methods and NO filesystem
 * access proves three things about the migrated operations:
 *
 *  1. the operations work with zero file paths (the projectDir never exists
 *     on disk, yet list/get/create/update/comment/attach all succeed);
 *  2. the operations genuinely `await` the ports (every fake method yields
 *     first — a forgotten `await` returns a pending Promise or a stale
 *     snapshot instead of the asserted value);
 *  3. the claim path uses the ATOMIC primitive (concurrent claimants take
 *     distinct tasks; the same race against a read-then-write adapter
 *     collides — so this test FAILS if the operation is ever reimplemented
 *     as list+update).
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ClaimPreview,
  TaskResolveOutcome,
  TaskStore,
} from "../../src/core/task-store.js";
import type { Task, TaskComment } from "../../src/core/types.js";
import type { FileInfo } from "../../src/core/files.js";
import type { OperationContext } from "../../src/core/operations.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

function baseTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    comments: [],
    files: [],
    ...overrides,
  };
}

/**
 * In-memory port with controllable atomicity. `atomic: true` serializes the
 * claim behind a promise mutex (the contract the real adapter keeps with a
 * file lock); `atomic: false` performs the read-then-write a naive
 * list+update reimplementation would do — first pick wins the race window
 * and every concurrent claimant takes the same task.
 */
class FakePortableStore implements TaskStore {
  calls: Record<string, number> = {};
  constructor(
    private tasks = new Map<string, Task>(),
    private atomic = true,
    private seq = 0,
  ) {}
  private count(name: string) {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }
  private find(idOrPrefix: string): Task | undefined {
    const all = [...this.tasks.values()];
    return (
      all.find((t) => t.id === idOrPrefix) ??
      all.find((t) => t.id.startsWith(idOrPrefix))
    );
  }
  async listTasks(): Promise<Task[]> {
    this.count("listTasks");
    await tick();
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }
  async getTask(_dir: string, idOrPrefix: string): Promise<Task | undefined> {
    this.count("getTask");
    await tick();
    const found = this.find(idOrPrefix);
    return found ? { ...found } : undefined;
  }
  async resolveTask(
    _dir: string,
    idOrPrefix: string,
  ): Promise<TaskResolveOutcome> {
    this.count("resolveTask");
    await tick();
    const found = this.find(idOrPrefix);
    if (!found) return { status: "missing", id: idOrPrefix };
    return { status: "found", id: found.id, task: { ...found } };
  }
  async createTask(_dir: string, input: Record<string, unknown>): Promise<Task> {
    this.count("createTask");
    await tick();
    const task = baseTask(`fake-${++this.seq}`, input as Partial<Task>);
    this.tasks.set(task.id, task);
    return { ...task };
  }
  async updateTask(
    _dir: string,
    taskId: string,
    updates: Record<string, unknown>,
  ): Promise<Task | null> {
    this.count("updateTask");
    await tick();
    const current = this.tasks.get(taskId);
    if (!current) return null;
    const next = { ...current, ...updates };
    this.tasks.set(taskId, next);
    return { ...next };
  }
  async deleteTask(_dir: string, taskId: string): Promise<boolean> {
    this.count("deleteTask");
    await tick();
    return this.tasks.delete(taskId);
  }
  async listComments(): Promise<TaskComment[]> {
    this.count("listComments");
    await tick();
    return [];
  }
  async addComment(
    _dir: string,
    taskId: string,
    author: TaskComment["author"],
    text: string,
  ): Promise<TaskComment> {
    this.count("addComment");
    await tick();
    if (!this.tasks.has(taskId)) throw new Error(`no such task: ${taskId}`);
    return {
      id: `c-${++this.seq}`,
      author,
      text,
      createdAt: new Date().toISOString(),
    };
  }
  async updateComment(): Promise<TaskComment | null> {
    this.count("updateComment");
    await tick();
    return null;
  }
  async deleteComment(): Promise<boolean> {
    this.count("deleteComment");
    await tick();
    return false;
  }
  async listFiles(): Promise<FileInfo[]> {
    this.count("listFiles");
    await tick();
    return [];
  }
  async saveFile(
    _dir: string,
    taskId: string,
    filename: string,
    data: Buffer,
  ): Promise<FileInfo> {
    this.count("saveFile");
    await tick();
    if (!this.tasks.has(taskId)) throw new Error(`no such task: ${taskId}`);
    return {
      name: filename,
      size: data.length,
      url: `/api/tasks/${taskId}/files/${encodeURIComponent(filename)}`,
    };
  }
  async deleteFile(): Promise<boolean> {
    this.count("deleteFile");
    await tick();
    return false;
  }
  async getFileCount(): Promise<number> {
    this.count("getFileCount");
    await tick();
    return 0;
  }
  async validateAttachment(_dir: string, filename: string) {
    this.count("validateAttachment");
    await tick();
    if (!filename.endsWith(".md")) {
      return {
        valid: false,
        errorCode: "UNSUPPORTED_FILE_TYPE",
        errorMessage: `fake store only accepts .md, got ${filename}`,
      };
    }
    return { valid: true, errorCode: "", errorMessage: "" };
  }

  private lock: Promise<void> = Promise.resolve();
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  private pickCandidate(): Task | null {
    const pool = [...this.tasks.values()]
      .filter((t) => t.status === "todo")
      .sort((a, b) => a.created.localeCompare(b.created));
    return pool[0] ?? null;
  }
  async claimNextTaskAtomic(): Promise<Task | null> {
    this.count("claimNextTaskAtomic");
    if (!this.atomic) {
      // Read-then-write: snapshot first, yield INSIDE the race window, then
      // write without rechecking — every concurrent claimant takes the same
      // task. This is the shape a list+update reimplementation has, and the
      // race test below proves it collides.
      const candidate = this.pickCandidate();
      await tick();
      await tick();
      if (!candidate) return null;
      return this.updateTask("", candidate.id, { status: "in-progress" });
    }
    return this.withLock(async () => {
      await tick();
      const candidate = this.pickCandidate();
      if (!candidate) return null;
      const claimed = { ...candidate, status: "in-progress" as const };
      this.tasks.set(candidate.id, claimed);
      await tick();
      return { ...claimed };
    });
  }
  async previewClaim(): Promise<ClaimPreview | null> {
    this.count("previewClaim");
    await tick();
    const candidate = this.pickCandidate();
    if (!candidate) return null;
    return { task: { ...candidate }, childClaim: false, parentId: null };
  }
}

function ctxFor(store: TaskStore, projectDir: string): OperationContext {
  return { projectDir, mode: "local", store };
}

describe("operations against a portable fake store (no filesystem)", () => {
  it("list/get/create/update/comment/attach succeed with zero file paths", async () => {
    const projectDir = join(tmpdir(), `portable-${Date.now()}-nodb`);
    const store = new FakePortableStore();
    const ctx = ctxFor(store, projectDir);
    const { listTasks, getTask, createTask, updateTask } = await import(
      "../../src/core/operations.js"
    );
    const { addComment } = await import("../../src/core/operations.js");
    const { attachFile } = await import("../../src/core/operations.js");

    const created = await createTask(ctx, {
      title: "portable",
      description: "",
      selector: "/",
    });
    expect(created.ok).toBe(true);
    const id = created.data!.id;

    const listed = await listTasks(ctx, {});
    expect(listed.ok && listed.data!.tasks.map((t) => t.id)).toContain(id);

    const got = await getTask(ctx, { id: id.slice(0, 6) });
    expect(got.ok && got.data!.id).toBe(id);

    const updated = await updateTask(ctx, {
      id,
      title: "renamed",
      comment: "delayed note",
    });
    expect(updated.ok).toBe(true);
    expect(updated.data!.title).toBe("renamed");

    const commented = await addComment(ctx, { id, comment: "hi" });
    expect(commented.ok).toBe(true);

    const attached = await attachFile(ctx, {
      id,
      filename: "note.md",
      contentB64: Buffer.from("x").toString("base64"),
    });
    expect(attached.ok).toBe(true);

    // The project directory was never created: no store path was touched.
    expect(existsSync(projectDir)).toBe(false);
  });

  it("delayed ports settle before dependent results are reported", async () => {
    const store = new FakePortableStore();
    const ctx = ctxFor(store, "portable-memory-board");
    const { createTask, updateTask } = await import(
      "../../src/core/operations.js"
    );
    const created = await createTask(ctx, {
      title: "slow",
      description: "",
      selector: "/",
    });
    // A forgotten `await` on the port returns a pending Promise as `data`,
    // not the created record — the id assertion below fails on it.
    expect(created.data!.id).toMatch(/^fake-/);
    const updated = await updateTask(ctx, {
      id: created.data!.id,
      title: "slow-2",
      comment: "settled note",
    });
    // A pre-write snapshot (or an un-awaited comment) reports the old title;
    // the port settles first, so the new title is what comes back.
    expect(updated.ok).toBe(true);
    expect(updated.data!.title).toBe("slow-2");
    expect(store.calls["addComment"]).toBe(1);
  });

  it("concurrent claims take distinct tasks through the atomic primitive", async () => {
    const tasks = new Map<string, Task>();
    for (let i = 0; i < 6; i++) tasks.set(`t-${i}`, baseTask(`t-${i}`));
    const store = new FakePortableStore(tasks, true);
    const ctx = ctxFor(store, "portable-memory-board");
    const { claimNextTask } = await import("../../src/core/operations.js");
    const before = { ...store.calls };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimNextTask(ctx, {})),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = results.map((r) => r.data!.id);
    // Six claimants, six distinct tasks: the lock serialized the takes.
    expect(new Set(ids).size).toBe(6);
    // And the claim decision never went through list+update: the operation
    // called the atomic primitive, not a read-then-write pair.
    expect((store.calls["listTasks"] ?? 0) - (before["listTasks"] ?? 0)).toBe(
      0,
    );
    expect(
      (store.calls["updateTask"] ?? 0) - (before["updateTask"] ?? 0),
    ).toBe(0);
    expect(store.calls["claimNextTaskAtomic"]).toBe(6);
  });

  it("the same race against a read-then-write adapter collides (control)", async () => {
    // CONTROL: proves the race test above bites. With the atomic primitive
    // replaced by list+update, concurrent claimants take the SAME task — so
    // a reimplementation of the claim as list+update fails the distinctness
    // assertion, exactly as it must.
    const tasks = new Map<string, Task>();
    for (let i = 0; i < 6; i++) tasks.set(`t-${i}`, baseTask(`t-${i}`));
    const store = new FakePortableStore(tasks, false);
    const ctx = ctxFor(store, "portable-memory-board");
    const { claimNextTask } = await import("../../src/core/operations.js");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimNextTask(ctx, {})),
    );
    const ids = results.map((r) => r.data!.id);
    expect(new Set(ids).size).toBeLessThan(6);
  });

  it("claim preview writes nothing and the live claim takes the previewed task", async () => {
    const tasks = new Map<string, Task>([["only", baseTask("only")]]);
    const store = new FakePortableStore(tasks, true);
    const ctx = ctxFor(store, "portable-memory-board");
    const { claimNextTask } = await import("../../src/core/operations.js");
    const preview = await claimNextTask(ctx, { dryRun: true });
    expect(preview.ok).toBe(true);
    expect(preview.data!.id).toBe("only");
    expect(
      preview.steps!.some((s) => s.code === "DRY_RUN"),
    ).toBe(true);
    // Still todo: the preview wrote nothing.
    expect((await store.getTask("", "only"))?.status).toBe("todo");
    const live = await claimNextTask(ctx, {});
    expect(live.data!.id).toBe("only");
  });
});
