import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createTask, listTasksWithPaths, updateTask } from "../../../src/core/tasks.js";
import { removeTagFromAllTasks } from "../../../src/core/remove-tag.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), "vf-remove-tag-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

function task(tags: string[]) {
  return createTask(dir, { title: "Tagged task", description: "", status: "todo", tags });
}
function snapshot() {
  return listTasksWithPaths(dir).map(t => ({ path: t.filePath, bytes: fs.readFileSync(t.filePath, "utf-8") }));
}

describe("removeTagFromAllTasks", () => {
  it("removes exact matches across all statuses, preserves other tags and fields, and counts changed tasks", () => {
    const one = task(["public", "internal", "public"]);
    const two = task(["public"]);
    updateTask(dir, two.id, { status: "done" });
    task(["Public", " public"]);
    expect(removeTagFromAllTasks(dir, "public")).toEqual({ removed: 2 });
    const rows = listTasksWithPaths(dir);
    expect(rows.find(t => t.id === one.id)).toMatchObject({ title: one.title, tags: ["internal"] });
    expect(rows.find(t => t.id === two.id)).toMatchObject({ status: "done", tags: [] });
    expect(rows.find(t => t.tags?.includes("Public"))?.tags).toEqual(["Public", " public"]);
    expect(removeTagFromAllTasks(dir, "public")).toEqual({ removed: 0 });
  });

  it.each(["", " ", null, "x".repeat(51)])("rejects invalid tag %s before writing", tag => {
    task(["public"]);
    const before = snapshot();
    expect(() => removeTagFromAllTasks(dir, tag)).toThrow(/tag must/);
    expect(snapshot()).toEqual(before);
  });

  it("rolls back every replaced file byte-for-byte when a later replacement fails", async () => {
    task(["public", "internal"]); task(["public"]); task(["public"]);
    const before = snapshot();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let replacements = 0;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(from).endsWith(".next.tmp") && ++replacements === 2) throw new Error("disk failure");
      actual.renameSync(from, to);
    });
    expect(() => removeTagFromAllTasks(dir, "public")).toThrow("disk failure");
    expect(snapshot()).toEqual(before);
    expect(fs.readdirSync(join(dir, ".vibeflow/tasks/.locks"))).toEqual([]);
    expect(fs.readdirSync(join(dir, ".vibeflow/tasks", new Date().toISOString().slice(0, 10))).some(f => f.endsWith(".tmp"))).toBe(false);
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
  });

  it("measures naive updates versus one staged batch on the same 120-task snapshot", () => {
    for (let n = 0; n < 120; n++) task(["public", "internal"]);
    const copy = join(dir, "copy");
    fs.cpSync(join(dir, ".vibeflow"), join(copy, ".vibeflow"), { recursive: true });
    function measure(run: () => void) {
      vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.writeFileSync).mockClear(); vi.mocked(fs.renameSync).mockClear();
      const start = performance.now(); run();
      return { ms: +(performance.now() - start).toFixed(2), reads: vi.mocked(fs.readFileSync).mock.calls.length, writes: vi.mocked(fs.writeFileSync).mock.calls.length, renames: vi.mocked(fs.renameSync).mock.calls.length, sqlStatements: 0 };
    }
    const naive = measure(() => {
      for (const row of listTasksWithPaths(dir)) updateTask(dir, row.id, { tags: row.tags!.filter(t => t !== "public") });
    });
    const batch = measure(() => { expect(removeTagFromAllTasks(copy, "public")).toEqual({ removed: 120 }); });
    console.log("120-task tag removal benchmark", JSON.stringify({ naive, batch }));
    expect(batch.renames).toBe(120);
    expect(batch.writes).toBe(240); // replacement + byte-exact rollback backup
    expect(listTasksWithPaths(copy).every(t => t.tags?.join() === "internal")).toBe(true);
  });
});
