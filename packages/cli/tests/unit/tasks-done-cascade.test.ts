import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureTaskDirs,
  createTask,
  listTasks,
  findTaskFilePath,
  updateTask,
} from "../../src/core/tasks.js";

// Count task-record writes (temp/rename) during a single call, to prove the
// cascade is one store write pass — not a per-child updateTask round trip.
// Passthrough mock: every byte still hits disk; only the call log is added.
const tmpWrites: string[] = [];
vi.mock("node:fs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("node:fs")>();
  const wrapped = (...args: Parameters<typeof actual.writeFileSync>) => {
    const target = String(args[0]);
    // Task-record writes only: the children-index sidecar (under
    // `.vibeflow-state/`) is counted separately where relevant.
    if (
      target.endsWith(".json.tmp") &&
      target.includes(".vibeflow/tasks")
    )
      tmpWrites.push(target);
    return (actual.writeFileSync as (...a: unknown[]) => unknown)(...args);
  };
  return { ...actual, writeFileSync: wrapped };
});

function taskFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json") && !e.name.endsWith(".tmp"))
        out.push(p);
    }
  };
  walk(join(dir, ".vibeflow", "tasks"));
  return out.sort();
}

describe("local done-cascade (parent done ⇒ descendants done)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "done-cascade-"));
    ensureTaskDirs(tempDir);
    tmpWrites.length = 0;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const mk = (title: string, status = "todo") =>
    createTask(tempDir, { title, description: "", status, selector: "/" }).id;

  const linkChild = (childId: string, parentId: string) => {
    const updated = updateTask(tempDir, childId, {
      links: [{ type: "parent" as const, taskId: parentId }],
    });
    expect(updated).not.toBeNull();
  };

  it("parent→done cascades to child and grandchild in one pass", () => {
    const parent = mk("parent");
    const child = mk("child");
    const grand = mk("grand");
    linkChild(child, parent);
    linkChild(grand, child);

    tmpWrites.length = 0;
    const updated = updateTask(tempDir, parent, { status: "done" });
    expect(updated?.status).toBe("done");

    const byId = new Map(listTasks(tempDir).map((t) => [t.id, t]));
    expect(byId.get(parent)!.status).toBe("done");
    expect(byId.get(child)!.status).toBe("done");
    expect(byId.get(grand)!.status).toBe("done");

    // One pass: exactly the parent + the two transitioned descendants, each
    // written once through the record writer. A per-child updateTask round
    // trip would re-list the board and re-lock per child instead.
    expect(tmpWrites).toHaveLength(3);

    // Same record shape as a normal edit: links/sortKey survive the cascade.
    expect(byId.get(child)!.links).toEqual([
      { type: "parent", taskId: parent },
    ]);
    expect(byId.get(grand)!.links).toEqual([
      { type: "parent", taskId: child },
    ]);
    for (const id of [parent, child, grand])
      expect(byId.get(id)!.sortKey).toMatch(/^\d+(\.\d+)?$/);
  });

  it("already-done child is left byte-untouched (idempotent)", () => {
    const parent = mk("parent");
    const child = mk("child");
    linkChild(child, parent);
    // Mark the child done first, then snapshot its exact bytes.
    expect(updateTask(tempDir, child, { status: "done" })?.status).toBe(
      "done",
    );
    const childPath = findTaskFilePath(tempDir, child)!;
    const before = readFileSync(childPath, "utf-8");

    tmpWrites.length = 0;
    updateTask(tempDir, parent, { status: "done" });

    // Untouched: no rewrite, no `updated` bump.
    expect(readFileSync(childPath, "utf-8")).toBe(before);
    // Only the parent transitioned, so only one record was written.
    expect(tmpWrites).toHaveLength(1);

    // Second identical edit is a no-op for the whole subtree.
    const parentPath = findTaskFilePath(tempDir, parent)!;
    const parentBefore = readFileSync(parentPath, "utf-8");
    tmpWrites.length = 0;
    updateTask(tempDir, parent, { status: "done" });
    expect(tmpWrites).toHaveLength(1); // parent rewrite only
    expect(listTasks(tempDir).find((t) => t.id === child)!.status).toBe(
      "done",
    );
    expect(parentBefore).not.toBe(""); // sanity: file existed
  });

  it("cycle terminates and never rewrites the root as its own descendant", () => {
    const parent = mk("parent");
    const child = mk("child");
    linkChild(child, parent);
    // Forge a cycle: the parent claims its own child as parent.
    linkChild(parent, child);

    tmpWrites.length = 0;
    const updated = updateTask(tempDir, parent, { status: "done" });
    expect(updated?.status).toBe("done");

    const byId = new Map(listTasks(tempDir).map((t) => [t.id, t]));
    expect(byId.get(parent)!.status).toBe("done");
    expect(byId.get(child)!.status).toBe("done");
    // Terminates (this line runs) and writes each record at most once.
    expect(tmpWrites.length).toBeLessThanOrEqual(2);
  });

  it("no reverse cascade: child done never touches the parent", () => {
    const parent = mk("parent");
    const child = mk("child");
    linkChild(child, parent);
    const parentPath = findTaskFilePath(tempDir, parent)!;
    const before = readFileSync(parentPath, "utf-8");
    const parentMtime = statSync(parentPath).mtimeMs;

    expect(updateTask(tempDir, child, { status: "done" })?.status).toBe(
      "done",
    );

    expect(listTasks(tempDir).find((t) => t.id === parent)!.status).toBe(
      "todo",
    );
    expect(readFileSync(parentPath, "utf-8")).toBe(before);
    expect(statSync(parentPath).mtimeMs).toBe(parentMtime);
  });

  it("task with no children behaves exactly as before (only its file changes)", () => {
    const solo = mk("solo");
    const unrelated = mk("unrelated");
    const before = new Map(
      taskFiles(tempDir).map((p) => [p, readFileSync(p, "utf-8")] as const),
    );

    const updated = updateTask(tempDir, solo, { status: "done" });
    expect(updated?.status).toBe("done");

    const after = new Map(
      taskFiles(tempDir).map((p) => [p, readFileSync(p, "utf-8")] as const),
    );
    // Same file set, exactly one file changed.
    expect([...after.keys()]).toEqual([...before.keys()]);
    const changed = [...after.keys()].filter(
      (p) => after.get(p) !== before.get(p),
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toBe(findTaskFilePath(tempDir, solo));
    // And the diff is exactly status + updated — nothing else rewritten.
    const beforeRec = JSON.parse(before.get(changed[0])!);
    const afterRec = JSON.parse(after.get(changed[0])!);
    const diffKeys = Object.keys(afterRec).filter(
      (k) => JSON.stringify(afterRec[k]) !== JSON.stringify(beforeRec[k]),
    );
    expect(new Set(diffKeys)).toEqual(new Set(["status", "updated"]));
    // Unrelated task untouched.
    expect(
      listTasks(tempDir).find((t) => t.id === unrelated)!.status,
    ).toBe("todo");
  });

  it("non-done transitions do not cascade", () => {
    const parent = mk("parent");
    const child = mk("child");
    linkChild(child, parent);

    updateTask(tempDir, parent, { status: "in-progress" });
    expect(
      listTasks(tempDir).find((t) => t.id === child)!.status,
    ).toBe("todo");
  });
});

describe("children-index sidecar", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "children-index-"));
    ensureTaskDirs(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const mk = (title: string, status = "todo") =>
    createTask(tempDir, { title, description: "", status, selector: "/" }).id;

  const linkChild = (childId: string, parentId: string) => {
    expect(
      updateTask(tempDir, childId, {
        links: [{ type: "parent" as const, taskId: parentId }],
      }),
    ).not.toBeNull();
  };

  const sidecarPath = () =>
    join(tempDir, ".vibeflow-state", "task-children.json");

  it("builds the sidecar on first cascade and reuses it (correct with index present)", () => {
    const parent = mk("parent");
    const child = mk("child");
    linkChild(child, parent);

    expect(existsSync(sidecarPath())).toBe(false);
    updateTask(tempDir, parent, { status: "done" });
    expect(existsSync(sidecarPath())).toBe(true);
    const index = JSON.parse(readFileSync(sidecarPath(), "utf-8"));
    expect(index.version).toBe(1);
    expect(index.parents[parent]).toEqual([child]);

    // Second tree cascades correctly off the PRESENT index (no rebuild).
    const parent2 = mk("parent2");
    const child2 = mk("child2");
    linkChild(child2, parent2); // link change invalidates…
    updateTask(tempDir, parent2, { status: "done" }); // …and rebuilds
    const byId = new Map(listTasks(tempDir).map((t) => [t.id, t]));
    expect(byId.get(child2)!.status).toBe("done");
    const rebuilt = JSON.parse(readFileSync(sidecarPath(), "utf-8"));
    expect(rebuilt.parents[parent2]).toEqual([child2]);
  });

  it("rebuilds after a link change (no stale miss of a new child)", () => {
    const parent = mk("parent");
    const child = mk("child");
    linkChild(child, parent);
    updateTask(tempDir, parent, { status: "done" }); // builds the index
    expect(listTasks(tempDir).find((t) => t.id === child)!.status).toBe(
      "done",
    );

    // Attach a NEW todo child after the index was built, then cascade again.
    // Without invalidation the stale map would miss it and it would stay todo.
    const late = mk("late-child");
    linkChild(late, parent);
    updateTask(tempDir, parent, { status: "done" });
    expect(listTasks(tempDir).find((t) => t.id === late)!.status).toBe(
      "done",
    );
  });

  it("deleted sidecar rebuilds (rebuild path, never a refusal)", () => {
    const parent = mk("parent");
    const child = mk("child");
    const grand = mk("grand");
    linkChild(child, parent);
    linkChild(grand, child);
    updateTask(tempDir, parent, { status: "done" });
    expect(existsSync(sidecarPath())).toBe(true);

    rmSync(sidecarPath());
    // Reset the tree to todo via fresh tasks to prove the rebuild cascades.
    const p2 = mk("p2");
    const c2 = mk("c2");
    linkChild(c2, p2);
    updateTask(tempDir, p2, { status: "done" });
    expect(listTasks(tempDir).find((t) => t.id === c2)!.status).toBe("done");
    expect(existsSync(sidecarPath())).toBe(true);
  });

  it("corrupt sidecar rebuilds without crashing", () => {
    const parent = mk("parent");
    const child = mk("child");
    linkChild(child, parent);
    updateTask(tempDir, parent, { status: "done" });

    mkdirSync(join(tempDir, ".vibeflow-state"), { recursive: true });
    writeFileSync(sidecarPath(), "{not json");
    const p2 = mk("p2");
    const c2 = mk("c2");
    linkChild(c2, p2);
    expect(() => updateTask(tempDir, p2, { status: "done" })).not.toThrow();
    expect(listTasks(tempDir).find((t) => t.id === c2)!.status).toBe("done");
  });

  it("lives outside the synced store and carries 0600 discipline", () => {
    const parent = mk("parent");
    updateTask(tempDir, parent, { status: "done" });
    expect(sidecarPath().includes(".vibeflow/tasks")).toBe(false);
    const mode = statSync(sidecarPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
