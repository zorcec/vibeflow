/**
 * M01: raw is the authority; projections cannot reconstruct record-only fields.
 * Testable invariant: local -> validated compatibility view -> canonical bytes
 * -> content hash equals the golden hash and validated server-stored raw hash.
 * JSON layout is not content: hashTaskRecord canonicalises compact JSON, while
 * toCanonicalBytes defines pretty on-disk bytes. Both have a fixed point.
 *
 * Real fixture captured from the live board on 2026-10-21; equality with stored
 * raw established by verify-local-vs-cloud (1-1, L1=0), as supplied by the owner.
 * Top-level author was redacted (personal name). No email, credential or
 * authStateEnc was present; this is a derived fixture, not an unredacted record.
 * The recorded server raw is an equality witness, not a new database test:
 * persisted-jsonb/projection tests belong to the server integration suite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTaskRecord, toCanonicalBytes, type TaskRecord } from "@vibeflow-tools/shared/task-record";
import { canonicalJson, hashTaskRecord } from "@vibeflow-tools/shared/delta-hash";
import { inspectLocalTaskRecord, taskRecordValidationView, taskReadNotices, type TaskReadFinding } from "../../src/core/task-record-read.js";
import { readTaskRecordFile, readTaskFile, listTasks, planTaskStoreNormalize, applyTaskStoreNormalize } from "../../src/core/tasks.js";
import { addComment } from "../../src/core/comments.js";
import { listTasks as listTasksOp } from "../../src/core/operations.js";
import vectors from "../../../shared/src/__tests__/fixtures/task-record-hash-vectors.json";
import defects from "../fixtures/task-record/historical-defects.json";
import realLocal from "../fixtures/task-record/real-board-local.json";
import realServerRaw from "../fixtures/task-record/real-board-stored-raw.json";
import realHash from "../fixtures/task-record/real-board-hash.json";
import openLabels from "../../../shared/src/__tests__/fixtures/task-record-open-labels.json";

function validated(input: unknown): TaskRecord {
  const result = parseTaskRecord(input);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("Invalid conformance input");
  return result.record;
}

function fixedPoint(record: TaskRecord, expectedHash: string): void {
  const bytes = toCanonicalBytes(record);
  const reparsed = validated(JSON.parse(bytes));
  expect(toCanonicalBytes(reparsed)).toBe(bytes);
  expect(hashTaskRecord(reparsed)).toBe(expectedHash);
  expect(hashTaskRecord(record)).toBe(expectedHash);
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vf-record-conformance-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
function write(raw: unknown, id = "task"): string {
  const root = join(dir, ".vibeflow", "tasks", "2026-03-01");
  mkdirSync(root, { recursive: true });
  const path = join(root, `${id}.json`);
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  return path;
}
const base = { id: "task", title: "Task", status: "todo", created: "2026-03-01T10:00:00Z" };

describe("local TaskRecord conformance (M01/M02)", () => {
  for (const vector of vectors) {
    it(`local file -> canonical bytes -> hash: ${vector.name}`, () => {
      const path = write(vector.record);
      const read = readTaskRecordFile(path);
      expect(read.issues).toEqual([]);
      expect(canonicalJson(read.canonical)).toBe(vector.canonical);
      fixedPoint(read.canonical!, vector.hash);
      // Server contract: validate -> store raw verbatim -> export. No display
      // defaults, columns-to-record reconstruction, timestamp or MIME invention.
      const storedRaw = JSON.parse(JSON.stringify(validated(vector.record)));
      expect(hashTaskRecord(storedRaw)).toBe(vector.hash);
    });
  }

  it("the redacted real-board local record agrees with recorded stored raw", () => {
    const path = write(realLocal);
    const before = readFileSync(path, "utf8");
    const mtime = statSync(path).mtimeMs;
    const read = readTaskRecordFile(path);
    expect(read.findings).toEqual([]);
    fixedPoint(read.canonical!, realHash.hash);
    const stored = validated(taskRecordValidationView(realServerRaw));
    expect(hashTaskRecord(stored)).toBe(realHash.hash);
    expect(toCanonicalBytes(stored)).toBe(toCanonicalBytes(read.canonical!));
    expect(hashTaskRecord(readTaskFile(path))).toBe(hashTaskRecord(realLocal));
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(planTaskStoreNormalize(dir).changes).toEqual([]);
  });

  for (const fixture of defects) {
    it(`historical fixture: ${fixture.name}`, () => {
      const path = write(fixture.local);
      const before = readFileSync(path, "utf8");
      const read = readTaskRecordFile(path);
      expect(read.issues).toEqual([]);
      fixedPoint(read.canonical!, fixture.hash);
      expect(hashTaskRecord(validated(fixture.serverRaw))).toBe(fixture.hash);
      expect(readFileSync(path, "utf8")).toBe(before);
      if (fixture.name === "long-comment") expect(read.canonical!.comments![0].text).toHaveLength(30_045);
      if (fixture.name === "chore-label") expect(read.canonical!.type).toBe("Chore");
      if (fixture.name === "linked-path") expect(read.canonical!.files![0].linkedPath).toBe("/example/reference.md");
      applyTaskStoreNormalize(dir);
      expect(planTaskStoreNormalize(dir).changes).toEqual([]);
      expect(applyTaskStoreNormalize(dir).applied).toEqual([]);
    });
  }
});

describe("read repair versus quarantine", () => {
  for (const fixture of openLabels) {
    for (const versioned of [true, false]) {
      it(`lists ${fixture.name} without quarantine, notices or normalization (${versioned ? "version 1" : "legacy"})`, () => {
        const raw: Record<string, unknown> = structuredClone(fixture.record);
        if (!versioned) {
          delete raw.schemaVersion;
          if (Array.isArray(raw.comments)) {
            for (const comment of raw.comments) delete comment.schemaVersion;
          }
        }
        const path = write(raw, String(raw.id));
        const before = readFileSync(path, "utf8");
        const read = readTaskRecordFile(path);
        expect(read.issues).toEqual([]);
        expect(read.findings).toEqual([]);
        expect(read.record).toStrictEqual(raw);
        expect(read.canonical).toStrictEqual(fixture.record);
        expect(toCanonicalBytes(read.canonical!)).toBe(toCanonicalBytes(validated(fixture.record)));
        expect(JSON.parse(toCanonicalBytes(read.canonical!))).toStrictEqual(fixture.record);
        const reads: TaskReadFinding[] = [];
        // Listing is a display projection; the strict raw/key witness is above.
        const listed = listTasks(dir, reads);
        expect(listed.map((task) => task.id)).toEqual([raw.id]);
        if (fixture.record.comments) expect(listed[0].comments).toStrictEqual(raw.comments);
        else expect(listed[0].commits).toStrictEqual(raw.commits);
        expect(reads).toEqual([]);
        expect(taskReadNotices(reads)).toEqual([]);
        const plan = planTaskStoreNormalize(dir);
        expect(plan.changes).toEqual([]);
        expect(plan.quarantined).toEqual([]);
        expect(plan.unreadable).toEqual([]);
        const applied = applyTaskStoreNormalize(dir);
        expect(applied.applied).toEqual([]);
        expect(applied.unwritten).toEqual([]);
        expect(readFileSync(path, "utf8")).toBe(before);
      });
    }
  }

  it("repairs aliases, missing child identity/timestamp, null scalars and partial links once", () => {
    const raw = { ...base, priority: null, links: [{ taskId: "parent", type: "parent" }, {}], comments: [{ role: "agent", content: "historical", at: base.created }, { author: "user", body: "second" }] };
    const path = write(raw);
    const before = readFileSync(path, "utf8");
    const read = readTaskRecordFile(path);
    expect(read.record).not.toBeNull();
    expect(read.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["alias-role", "alias-content", "alias-at", "alias-body", "mint-comment-id", "missing-comment-timestamp", "drop-null-scalars", "filter-links"]));
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(planTaskStoreNormalize(dir).changes).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(applyTaskStoreNormalize(dir).applied).toHaveLength(1);
    expect(planTaskStoreNormalize(dir).changes).toEqual([]);
    expect(readTaskRecordFile(path).canonical).toEqual(read.canonical);
  });

  for (const [name, extra] of [
    ["unknown root key", { localOnly: "deliberate" }],
    ["unknown nested key", { links: [{ taskId: "x", type: "parent", note: "deliberate" }] }],
    ["future schema", { schemaVersion: 2, type: "[object Object]" }],
    ["alias conflict", { comments: [{ id: "c", author: "user", text: "one", content: "two", createdAt: base.created }] }],
    ["invalid timestamp", { commits: [{ sha: "a", message: "m", timestamp: "t" }] }],
    ["missing commit fields", { commits: [{ sha: "a" }] }],
    ["null tags", { tags: null }],
    ["invalid status", { status: "deliberate-custom-state" }],
    ["empty author", { comments: [{ id: "c", author: "", text: "message", createdAt: base.created }] }],
    ["non-string author", { comments: [{ id: "c", author: 42, text: "message", createdAt: base.created }] }],
    ["missing author", { comments: [{ id: "c", text: "message", createdAt: base.created }] }],
    ["empty title", { title: "" }],
    ["invalid source", { comments: [{ id: "c", author: "user", text: "message", createdAt: base.created, source: "saas" }] }],
  ] as const) {
    it(`quarantines ${name} without changing disk or deleting data`, async () => {
      const path = write({ ...base, ...extra });
      const before = readFileSync(path, "utf8");
      expect(readTaskRecordFile(path).record).toBeNull();
      await expect(addComment(dir, "task", "agent", "must not replace the record")).rejects.toThrow("unreadable/quarantined");
      const reads: TaskReadFinding[] = [];
      expect(listTasks(dir, reads)).toEqual([]);
      expect(taskReadNotices(reads)).toEqual([{ code: "TASK_RECORD_QUARANTINED", message: expect.stringContaining("1 task record(s)") }]);
      const result = await listTasksOp({ projectDir: dir, mode: "local" }, {});
      expect(result.ok).toBe(true);
      expect(result.steps?.[0].message).toContain("task");
      expect(planTaskStoreNormalize(dir).quarantined).toHaveLength(1);
      expect(applyTaskStoreNormalize(dir).applied).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  }

  it("reports repair ids separately from quarantined ids and never enumerates auth sidecars", () => {
    write({ ...base, id: "repair", type: "[object Object]" }, "repair");
    write({ ...base, id: "bad", unknownKey: "keep" }, "bad");
    write({ secret: "not-a-task" }, "task.auth");
    const reads: TaskReadFinding[] = [];
    expect(listTasks(dir, reads).map((task) => task.id)).toEqual(["repair"]);
    expect(taskReadNotices(reads)).toEqual([
      { code: "TASK_RECORD_REPAIRED", message: "1 task record(s) repaired in memory (disk unchanged): repair. Run tasks --normalize for repair details." },
      { code: "TASK_RECORD_QUARANTINED", message: "1 task record(s) quarantined (excluded from listing/merge/push): bad. Not auto-repairable: bad: <root>: Unrecognized key(s) in object: 'unknownKey'. Run tasks --normalize for repair details." },
    ]);
    expect(planTaskStoreNormalize(dir).unreadable).toEqual([]);
    expect(planTaskStoreNormalize(dir).quarantined.map((r) => r.id)).toEqual(["bad"]);
  });

  it("missing title/created are rejected without inventing required data", () => {
    for (const raw of [{ id: "task", title: "t" }, { id: "task", status: "todo", created: base.created }]) {
      const path = write(raw);
      const before = readFileSync(path, "utf8");
      expect(readTaskRecordFile(path).record).toBeNull();
      expect(applyTaskStoreNormalize(dir).applied).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  it("invalid JSON never crashes listing and is never normalised", () => {
    const path = write(base);
    writeFileSync(path, "{broken");
    const reads: TaskReadFinding[] = [];
    expect(listTasks(dir, reads)).toEqual([]);
    expect(reads[0].issues[0].code).toBe("unreadable_json");
    expect(planTaskStoreNormalize(dir).unreadable).toEqual([path]);
    expect(applyTaskStoreNormalize(dir).applied).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("{broken");
  });
});
