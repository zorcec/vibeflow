import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTask } from "../../src/core/tasks.js";
import { listFiles, saveFile, migrateAllLegacyLinkedRefs } from "../../src/core/files.js";

describe("readTaskFileRefs (pure read, no side-effects)", () => {
  it("listFiles does not mutate task JSON or legacy manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "files-pure-"));
    const task = createTask(dir, {
      title: "Pure read test",
      description: "",
      status: "todo",
      selector: "/",
    });

    const filesDir = join(dir, ".vibeflow", "tasks", "files", task.id);
    mkdirSync(filesDir, { recursive: true });
    const manifestPath = join(filesDir, ".linked.json");
    writeFileSync(manifestPath, JSON.stringify([{ name: "legacy.md", path: "/tmp/legacy.md" }]));

    const taskFile = join(dir, ".vibeflow", "tasks", task.created.slice(0, 10), `${task.id}.json`);
    const beforeContent = readFileSync(taskFile, "utf-8");

    listFiles(dir, task.id);
    listFiles(dir, task.id);

    const afterContent = readFileSync(taskFile, "utf-8");
    expect(afterContent).toBe(beforeContent);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("saveFile triggers migration (legacy manifest removed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "files-migrate-"));
    const task = createTask(dir, {
      title: "Migrate test",
      description: "",
      status: "todo",
      selector: "/",
    });

    const filesDir = join(dir, ".vibeflow", "tasks", "files", task.id);
    mkdirSync(filesDir, { recursive: true });
    const manifestPath = join(filesDir, ".linked.json");
    writeFileSync(manifestPath, JSON.stringify([{ name: "legacy.md", path: "/tmp/legacy.md" }]));

    saveFile(dir, task.id, "new.txt", Buffer.from("hello"));
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("migrateAllLegacyLinkedRefs sweeps all tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "files-sweep-"));
    const task = createTask(dir, {
      title: "Sweep test",
      description: "",
      status: "todo",
      selector: "/",
    });

    const filesDir = join(dir, ".vibeflow", "tasks", "files", task.id);
    mkdirSync(filesDir, { recursive: true });
    const manifestPath = join(filesDir, ".linked.json");
    writeFileSync(manifestPath, JSON.stringify([{ name: "legacy.md", path: "/tmp/legacy.md" }]));

    const count = await migrateAllLegacyLinkedRefs(dir);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(existsSync(manifestPath)).toBe(false);
  });
});
