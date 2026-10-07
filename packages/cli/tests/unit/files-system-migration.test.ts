import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureFilesDir,
  getFilesDir,
  listFiles,
  saveFile,
  migrateAllLegacyLinkedRefs,
} from "../../src/core/files.js";
import {
  createTask,
  findTaskFilePath,
  updateTask,
} from "../../src/core/tasks.js";

/**
 * Lazy backfill + one-shot sweep for the system-file flag.
 * Pre-flag task JSON gains `system: true` on engine-named refs; user files
 * (including lookalikes like verify-notes.md) are untouched.
 */
describe("system-flag migration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-sysmig-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeTask() {
    return createTask(tempDir, {
      title: "Migration test",
      description: "",
      status: "todo",
      selector: "/",
    });
  }

  /** Simulates pre-flag data by stripping every system key from task JSON. */
  function stripFlags(taskId: string): void {
    const p = findTaskFilePath(tempDir, taskId)!;
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as {
      files?: Array<Record<string, unknown>>;
    };
    for (const r of parsed.files ?? []) delete r["system"];
    writeFileSync(p, JSON.stringify(parsed, null, 2));
  }

  function taskJson(taskId: string): string {
    return readFileSync(findTaskFilePath(tempDir, taskId)!, "utf-8");
  }

  it("lazy backfill on write flags engine refs, keeps user files unflagged", () => {
    const task = makeTask();
    saveFile(tempDir, task.id, "user-notes.md", Buffer.from("u"));
    saveFile(tempDir, task.id, "verify-after.json", Buffer.from("{}"));
    saveFile(tempDir, task.id, "verify-notes.md", Buffer.from("mine"));
    stripFlags(task.id);

    // Next write triggers the lazy backfill.
    saveFile(tempDir, task.id, "another.md", Buffer.from("x"));

    const after = listFiles(tempDir, task.id);
    expect(after.find((f) => f.name === "verify-after.json")!.system).toBe(
      true,
    );
    expect(
      after.find((f) => f.name === "user-notes.md")!.system,
    ).toBeUndefined();
    // .md lookalike is not in the engine set — stays a user file.
    expect(
      after.find((f) => f.name === "verify-notes.md")!.system,
    ).toBeUndefined();
  });

  it("backfill is case-insensitive (engine always writes lowercase)", () => {
    const task = makeTask();
    updateTask(tempDir, task.id, {
      files: [
        { name: "Verify-After.JSON", addedAt: new Date().toISOString() },
      ],
    });
    ensureFilesDir(tempDir, task.id);
    writeFileSync(
      join(getFilesDir(tempDir, task.id), "Verify-After.JSON"),
      "{}",
    );
    saveFile(tempDir, task.id, "poke.md", Buffer.from("p"));
    expect(
      listFiles(tempDir, task.id).find((f) => f.name === "Verify-After.JSON")!
        .system,
    ).toBe(true);
  });

  it("sweep covers untouched tasks and a second sweep is byte-identical", async () => {
    const task = makeTask();
    saveFile(tempDir, task.id, "verify-diff.json", Buffer.from("{}"));
    saveFile(tempDir, task.id, "notes.md", Buffer.from("u"));
    stripFlags(task.id);

    const count = await migrateAllLegacyLinkedRefs(tempDir);
    expect(count).toBeGreaterThanOrEqual(1);
    const after = listFiles(tempDir, task.id);
    expect(after.find((f) => f.name === "verify-diff.json")!.system).toBe(
      true,
    );
    expect(after.find((f) => f.name === "notes.md")!.system).toBeUndefined();

    const first = taskJson(task.id);
    const secondCount = await migrateAllLegacyLinkedRefs(tempDir);
    expect(secondCount).toBe(0);
    expect(taskJson(task.id)).toBe(first);
  });

  it("backfill creates refs for ref-less on-disk engine files", () => {
    const task = makeTask();
    ensureFilesDir(tempDir, task.id);
    writeFileSync(
      join(getFilesDir(tempDir, task.id), "baseline-element.json"),
      "{}",
    );
    writeFileSync(join(getFilesDir(tempDir, task.id), "sketch.png"), "png");
    // A write triggers the backfill, which refs both orphans at once.
    saveFile(tempDir, task.id, "poke.md", Buffer.from("p"));
    const after = listFiles(tempDir, task.id);
    expect(
      after.find((f) => f.name === "baseline-element.json")!.system,
    ).toBe(true);
    expect(after.find((f) => f.name === "sketch.png")!.system).toBeUndefined();
  });
});
