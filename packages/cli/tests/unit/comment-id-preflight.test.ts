import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deterministicCommentId, inspectLocalTaskRecord } from "../../src/core/task-record-read.js";
import { applyTaskStoreNormalize, planTaskStoreNormalize, prepareTaskRecordsForPush } from "../../src/core/tasks.js";

const base = { id: "task", title: "Task", status: "todo", created: "2026-03-01T10:00:00Z" };
const comment = { author: "agent", text: "historical 📝", createdAt: base.created };
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vf-comment-preflight-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function write(record: unknown): string {
  const root = join(dir, ".vibeflow", "tasks");
  mkdirSync(root, { recursive: true });
  const path = join(root, "task.json");
  writeFileSync(path, JSON.stringify(record) + "\n");
  return path;
}

describe("comment-id repair (ae9e99fd)", () => {
  it("normalizes once, with the same id across two runs and two fresh processes", () => {
    const raw = { ...base, comments: [comment] };
    const path = write(raw);
    const id = deterministicCommentId(base.id, comment.author, comment.text, 0);
    expect(planTaskStoreNormalize(dir).changes[0].changes).toContainEqual({
      rule: "mint-comment-id", field: "comments[0].id", before: undefined, after: id,
    });
    const runner = join(dir, "repair.cjs");
    buildSync({
      stdin: {
        contents: `import { inspectLocalTaskRecord } from ${JSON.stringify(resolve("src/core/task-record-read.ts"))};\nprocess.stdout.write(JSON.stringify(inspectLocalTaskRecord(JSON.parse(process.argv[2])).record));`,
        resolveDir: process.cwd(),
      },
      bundle: true, platform: "node", format: "cjs", outfile: runner,
    });
    for (let i = 0; i < 2; i++) {
      const result = JSON.parse(execFileSync(process.execPath, [runner, JSON.stringify(raw)], { encoding: "utf8" }));
      expect(result.comments[0].id).toBe(id);
    }
    expect(applyTaskStoreNormalize(dir).applied).toHaveLength(1);
    const first = readFileSync(path, "utf8");
    expect(JSON.parse(first).comments[0].id).toBe(id);
    expect(applyTaskStoreNormalize(dir).applied).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("never rewrites an existing id or the bytes of an already valid record", () => {
    const existing = { ...comment, id: "c179dd7c-server-or-record-id", updatedAt: "2026-03-02T10:00:00.123456Z" };
    const path = write({ ...base, comments: [existing] });
    const before = readFileSync(path, "utf8");
    expect(applyTaskStoreNormalize(dir).applied).toEqual([]);
    prepareTaskRecordsForPush(dir);
    expect(readFileSync(path, "utf8")).toBe(before);
    // Another comment's repair must preserve every byte of existing content.
    write({ ...base, comments: [existing, comment] });
    prepareTaskRecordsForPush(dir);
    expect(JSON.stringify(JSON.parse(readFileSync(path, "utf8")).comments[0])).toBe(JSON.stringify(existing));
  });

  it("persists before handing any snapshot to the payload builder", () => {
    const path = write({ ...base, comments: [comment] });
    const snapshots = prepareTaskRecordsForPush(dir);
    const disk = JSON.parse(readFileSync(path, "utf8"));
    expect(disk.comments[0].id).toBe(deterministicCommentId(base.id, comment.author, comment.text, 0));
    expect(snapshots[0].comments![0].id).toBe(disk.comments[0].id);
    expect(planTaskStoreNormalize(dir).changes).toEqual([]);
    const bytes = readFileSync(path, "utf8");
    prepareTaskRecordsForPush(dir);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it("dry-run repairs only in memory", () => {
    const path = write({ ...base, comments: [comment] });
    const before = readFileSync(path, "utf8");
    expect(prepareTaskRecordsForPush(dir, [], true)[0].comments![0].id).toBeTruthy();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses an unrepairable record with the task id and reason, without changing disk", () => {
    const path = write({ ...base, comments: [{ text: "missing author", createdAt: base.created }] });
    const before = readFileSync(path, "utf8");
    expect(() => prepareTaskRecordsForPush(dir)).toThrow(/Task task: push preflight failed: comments\[0\]\.(author|id):/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a derived-id collision rather than overwriting or minting a competing id", () => {
    const id = deterministicCommentId(base.id, comment.author, comment.text, 0);
    const raw = { ...base, comments: [comment, { ...comment, id }] };
    const path = write(raw);
    const read = inspectLocalTaskRecord(raw);
    expect(read.record).toBeNull();
    expect(read.issues[0].code).toBe("comment_id_collision");
    expect(() => prepareTaskRecordsForPush(dir)).toThrow(/Task task:.*conflicts with an existing comment id/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(raw);
  });
});
