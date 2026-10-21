/**
 * Pull unpack + additive merge (saas/pull-archive.ts).
 *
 * The merge is the safety core of `vibeflow pull`: additive, local-wins by
 * default, never destructive. These tests pin that — a local-only field or
 * byte survives a pull, a re-pull of an unchanged board writes nothing, and
 * any verification failure leaves the store byte-identical.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { writeTar } from "@vibeflow-tools/shared/tar";
import {
  hashTaskRecord,
  sha256Hex,
} from "@vibeflow-tools/shared/delta-hash";
import {
  mergePullRecord,
  mergePullComments,
  mergePullLinks,
  applyPullEntries,
  verifyPullStaging,
  stagePullArchive,
  runPullFromBytes,
  PullVerifyError,
  type PullStaging,
  type PullManifest,
} from "../../../src/saas/pull-archive.js";

let projectDir: string;

function writeTask(id: string, record: Record<string, unknown>): void {
  const dir = join(projectDir, ".vibeflow", "tasks", "2026-01-01");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record));
}

function readStoredTask(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(projectDir, ".vibeflow", "tasks", "2026-01-01", `${id}.json`),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

function taskRecord(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: "desc",
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    comments: [],
    files: [],
    ...extra,
  };
}

/** Build a minimal valid archive: manifest + task envelopes + file bytes. */
function makeArchive(
  tasks: Array<{ clientId: string; record: Record<string, unknown> }>,
  files: Array<{ clientId: string; name: string; data: Buffer }> = [],
  manifestPatch: Record<string, unknown> = {},
): Buffer {
  const manifest: Record<string, unknown> = {
    version: 1,
    kind: "vibeflow-board-export",
    boardId: "b_1",
    taskCount: tasks.length,
    fileCount: files.length,
    totalFileBytes: files.reduce((s, f) => s + f.data.length, 0),
    tasks: tasks.map((t) => ({
      cliId: t.clientId,
      hash: hashTaskRecord(t.record),
      fileCount: files.filter((f) => f.clientId === t.clientId).length,
    })),
    files: files.map((f) => ({
      cliId: f.clientId,
      name: f.name,
      size: f.data.length,
      sha256: sha256Hex(f.data),
    })),
    ...manifestPatch,
  };
  return gzipSync(
    writeTar([
      { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
      ...tasks.map((t) => ({
        path: `tasks/${t.clientId}.json`,
        data: Buffer.from(
          JSON.stringify({
            clientId: t.clientId,
            record: t.record,
            fields: t.record,
          }),
        ),
      })),
      ...files.map((f) => ({
        path: `files/${f.clientId}/${f.name}`,
        data: f.data,
      })),
    ]),
  );
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "pull-archive-test-"));
});

afterEach(() => {
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
});

describe("mergePullRecord — additive, local-wins", () => {
  it("adds remote-only keys and keeps local-only keys", () => {
    const local = { id: "a", title: "Local", localOnly: 1 };
    const remote = { id: "a", title: "Local", remoteOnly: 2 };
    const { merged, changed, conflict } = mergePullRecord(local, remote, false);
    expect(merged).toMatchObject({ id: "a", title: "Local", localOnly: 1, remoteOnly: 2 });
    expect(changed).toBe(true);
    expect(conflict).toBe(false);
  });

  it("keeps the local value on a conflict by default and reports it", () => {
    const local = { id: "a", title: "Local" };
    const remote = { id: "a", title: "Remote" };
    const { merged, changed, conflict } = mergePullRecord(local, remote, false);
    expect(merged.title).toBe("Local");
    expect(changed).toBe(false);
    expect(conflict).toBe(true);
  });

  it("--prefer-remote takes the remote value on a conflict", () => {
    const local = { id: "a", title: "Local" };
    const remote = { id: "a", title: "Remote" };
    const { merged, changed, conflict } = mergePullRecord(local, remote, true);
    expect(merged.title).toBe("Remote");
    expect(changed).toBe(true);
    expect(conflict).toBe(true);
  });

  it("identical records merge to an unchanged no-op", () => {
    const record = taskRecord("a", { priority: "High" });
    const { merged, changed, conflict } = mergePullRecord(record, { ...record }, false);
    expect(changed).toBe(false);
    expect(conflict).toBe(false);
    expect(merged).toEqual(record);
  });

  it("never imports filePath or authStateEnc", () => {
    const local = { id: "a", title: "T" };
    const remote = { id: "a", title: "T", filePath: "/tmp/x.json", authStateEnc: "secret" };
    const { merged, changed } = mergePullRecord(local, remote, true);
    expect("filePath" in merged).toBe(false);
    expect("authStateEnc" in merged).toBe(false);
    expect(changed).toBe(false);
  });

  it("keeps the local sortKey on an existing task, even with --prefer-remote off the table", () => {
    const local = { id: "a", sortKey: "0000000001000000" };
    const remote = { id: "a", sortKey: "0000000009000000" };
    const kept = mergePullRecord(local, remote, false);
    expect(kept.merged.sortKey).toBe("0000000001000000");
    expect(kept.conflict).toBe(true);
    const taken = mergePullRecord(local, remote, true);
    expect(taken.merged.sortKey).toBe("0000000009000000");
  });

  it("takes a remote sortKey when the local task has none", () => {
    const { merged, changed } = mergePullRecord({ id: "a" }, { id: "a", sortKey: "0005" }, false);
    expect(merged.sortKey).toBe("0005");
    expect(changed).toBe(true);
  });
});

describe("mergePullComments — by id", () => {
  const c1 = { id: "c1", author: "user", text: "local", createdAt: "2026-01-01" };
  it("appends remote-only comments", () => {
    const c2 = { id: "c2", author: "agent", text: "remote", createdAt: "2026-01-02" };
    const { comments, changed, conflict } = mergePullComments([c1], [c1, c2], false);
    expect(comments).toHaveLength(2);
    expect(changed).toBe(true);
    expect(conflict).toBe(false);
  });

  it("a same-id local comment wins by default", () => {
    const edited = { ...c1, text: "remote edit" };
    const { comments, changed, conflict } = mergePullComments([c1], [edited], false);
    expect(comments[0].text).toBe("local");
    expect(changed).toBe(false);
    expect(conflict).toBe(true);
  });

  it("--prefer-remote replaces a same-id comment", () => {
    const edited = { ...c1, text: "remote edit" };
    const { comments, changed } = mergePullComments([c1], [edited], true);
    expect(comments[0].text).toBe("remote edit");
    expect(changed).toBe(true);
  });
});

describe("mergePullLinks — union, never destructive", () => {
  it("adds remote-only links and keeps local order", () => {
    const local = [{ taskId: "p", type: "parent" }];
    const remote = [
      { taskId: "p", type: "parent" },
      { taskId: "r", type: "relates" },
    ];
    const { links, changed } = mergePullLinks(local, remote);
    expect(links).toEqual([
      { taskId: "p", type: "parent" },
      { taskId: "r", type: "relates" },
    ]);
    expect(changed).toBe(true);
  });

  it("a local-only link survives the merge", () => {
    const { links, changed } = mergePullLinks(
      [{ taskId: "mine", type: "relates" }],
      [],
    );
    expect(links).toEqual([{ taskId: "mine", type: "relates" }]);
    expect(changed).toBe(false);
  });
});

describe("applyPullEntries — the store merge", () => {
  function stagingFor(
    tasks: Array<{ clientId: string; record: Record<string, unknown> }>,
    files: PullStaging["files"] = [],
  ): PullStaging {
    const manifestFiles = files.map((f) => ({
      cliId: f.clientId,
      name: f.name,
      size: f.data.length,
      sha256: sha256Hex(f.data),
    }));
    return {
      manifest: {
        version: 1,
        taskCount: tasks.length,
        fileCount: files.length,
        tasks: tasks.map((t) => ({ cliId: t.clientId })),
        files: manifestFiles,
      },
      tasks,
      files,
      missingBytes: [],
    };
  }

  it("writes new tasks into date subdirs with the remote sortKey verbatim", () => {
    const record = taskRecord("new-1", { sortKey: "0000000007000000" });
    const summary = applyPullEntries(
      projectDir,
      stagingFor([{ clientId: "new-1", record }]),
      {},
    );
    expect(summary.added).toBe(1);
    expect(summary.merged).toBe(0);
    const stored = readStoredTask("new-1");
    expect(stored.title).toBe("Task new-1");
    expect(stored.sortKey).toBe("0000000007000000");
  });

  it("merges into an existing task: local-only field kept, remote-only added, reported merged", () => {
    writeTask("t1", taskRecord("t1", { localNote: "mine", title: "Local title" }));
    const record = taskRecord("t1", { title: "Local title", remoteFlag: true });
    const summary = applyPullEntries(
      projectDir,
      stagingFor([{ clientId: "t1", record: { ...record, title: "Remote title" } }]),
      {},
    );
    expect(summary.merged).toBe(1);
    expect(summary.added).toBe(0);
    expect(summary.conflicts).toBe(1);
    const stored = readStoredTask("t1");
    expect(stored.localNote).toBe("mine");
    expect(stored.remoteFlag).toBe(true);
    // Local wins: the title conflict kept the local value.
    expect(stored.title).toBe("Local title");
  });

  it("an unchanged task is byte-identical after the pull (a re-pull is a no-op)", () => {
    const record = taskRecord("same-1", { priority: "High", sortKey: "0001" });
    writeTask("same-1", record);
    const before = readFileSync(
      join(projectDir, ".vibeflow", "tasks", "2026-01-01", "same-1.json"),
      "utf-8",
    );
    const summary = applyPullEntries(
      projectDir,
      stagingFor([{ clientId: "same-1", record: { ...record } }]),
      {},
    );
    expect(summary.unchanged).toBe(1);
    expect(summary.merged).toBe(0);
    expect(
      readFileSync(
        join(projectDir, ".vibeflow", "tasks", "2026-01-01", "same-1.json"),
        "utf-8",
      ),
    ).toBe(before);
  });

  it("--dry-run computes the plan and writes nothing", () => {
    writeTask("d1", taskRecord("d1", { title: "Local" }));
    const staging = stagingFor([
      { clientId: "d1", record: taskRecord("d1", { title: "Remote", extra: 1 }) },
      { clientId: "d2", record: taskRecord("d2") },
    ]);
    const summary = applyPullEntries(projectDir, staging, { dryRun: true });
    expect(summary.merged).toBe(1);
    expect(summary.added).toBe(1);
    // Nothing landed: no new file, and the merged file is untouched.
    expect(
      existsSync(join(projectDir, ".vibeflow", "tasks", "2026-01-01", "d2.json")),
    ).toBe(false);
    expect(readStoredTask("d1").title).toBe("Local");
  });

  it("local file bytes win by default; --prefer-remote replaces them", () => {
    const record = taskRecord("f1");
    writeTask("f1", record);
    const filesDir = join(projectDir, ".vibeflow", "tasks", "files", "f1");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "note.txt"), "local bytes");
    const remote = { clientId: "f1", name: "note.txt", data: Buffer.from("remote bytes") };

    const kept = applyPullEntries(
      projectDir,
      stagingFor([{ clientId: "f1", record }], [remote]),
      {},
    );
    expect(kept.filesKept).toBe(1);
    expect(kept.filesWritten).toBe(0);
    expect(readFileSync(join(filesDir, "note.txt"), "utf-8")).toBe("local bytes");

    const replaced = applyPullEntries(
      projectDir,
      stagingFor([{ clientId: "f1", record }], [remote]),
      { preferRemote: true },
    );
    expect(replaced.filesWritten).toBe(1);
    expect(readFileSync(join(filesDir, "note.txt"), "utf-8")).toBe("remote bytes");
  });

  it("identical files are not rewritten; missing files are written; linked refs are reported", () => {
    const record = taskRecord("f2");
    writeTask("f2", record);
    const filesDir = join(projectDir, ".vibeflow", "tasks", "files", "f2");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "same.txt"), "same");
    const staging = stagingFor([{ clientId: "f2", record }], [
      { clientId: "f2", name: "same.txt", data: Buffer.from("same") },
      { clientId: "f2", name: "new.txt", data: Buffer.from("new") },
    ]);
    staging.missingBytes = [{ cliId: "f2", name: "linked.md" }];
    const summary = applyPullEntries(projectDir, staging, {});
    expect(summary.filesIdentical).toBe(1);
    expect(summary.filesWritten).toBe(1);
    expect(summary.missingBytes).toBe(1);
    expect(readFileSync(join(filesDir, "new.txt"), "utf-8")).toBe("new");
  });
});

describe("verifyPullStaging — refuse before the first write", () => {
  function staged(
    tasks: Array<{ clientId: string; record: Record<string, unknown> }>,
    manifestPatch: Record<string, unknown> = {},
  ): PullStaging {
    const manifest = {
      version: 1,
      taskCount: tasks.length,
      fileCount: 0,
      tasks: tasks.map((t) => ({ cliId: t.clientId, hash: hashTaskRecord(t.record) })),
      ...manifestPatch,
    } as PullManifest;
    return { manifest, tasks, files: [], missingBytes: [] };
  }

  it("accepts a well-formed staging", () => {
    expect(() =>
      verifyPullStaging(staged([{ clientId: "a", record: taskRecord("a") }])),
    ).not.toThrow();
  });

  it("refuses a non-1 manifest version", () => {
    expect(() =>
      verifyPullStaging(
        staged([{ clientId: "a", record: taskRecord("a") }], { version: 2 }),
      ),
    ).toThrow(PullVerifyError);
  });

  it("refuses a task count mismatch", () => {
    expect(() =>
      verifyPullStaging(
        staged([{ clientId: "a", record: taskRecord("a") }], { taskCount: 5 }),
      ),
    ).toThrow(/count mismatch/);
  });

  it("refuses a record whose id disagrees with its path", () => {
    expect(() =>
      verifyPullStaging(
        staged([{ clientId: "a", record: taskRecord("WRONG") }]),
      ),
    ).toThrow(/id mismatch/);
  });

  it("refuses a task that fails its manifest hash", () => {
    const record = taskRecord("a");
    const staging = staged([{ clientId: "a", record }]);
    staging.manifest.tasks = [{ cliId: "a", hash: "0".repeat(64) }];
    expect(() => verifyPullStaging(staging)).toThrow(PullVerifyError);
  });

  it("refuses a file that fails its manifest sha256", () => {
    const data = Buffer.from("bytes");
    const staging: PullStaging = {
      manifest: {
        version: 1,
        taskCount: 0,
        fileCount: 1,
        files: [{ cliId: "a", name: "x.bin", size: data.length, sha256: "1".repeat(64) }],
      },
      tasks: [],
      files: [{ clientId: "a", name: "x.bin", data }],
      missingBytes: [],
    };
    expect(() => verifyPullStaging(staging)).toThrow(PullVerifyError);
  });
});

describe("runPullFromBytes — stage, verify, merge", () => {
  it("unpacks a real gzipped tar into the store, and a second run is a no-op", async () => {
    const record = taskRecord("a1", { sortKey: "0003" });
    const bytes = makeArchive(
      [{ clientId: "a1", record }],
      [{ clientId: "a1", name: "note.txt", data: Buffer.from("hello") }],
    );
    const first = await runPullFromBytes(projectDir, bytes, {});
    expect(first.summary.added).toBe(1);
    expect(first.summary.filesWritten).toBe(1);
    expect(first.manifest.version).toBe(1);
    expect(readStoredTask("a1").title).toBe("Task a1");
    expect(
      readFileSync(
        join(projectDir, ".vibeflow", "tasks", "files", "a1", "note.txt"),
        "utf-8",
      ),
    ).toBe("hello");

    const second = await runPullFromBytes(projectDir, bytes, {});
    expect(second.summary.unchanged).toBe(1);
    expect(second.summary.filesIdentical).toBe(1);
    expect(second.summary.added).toBe(0);
  });

  it("leaves no temp dir and writes nothing when the gzip is corrupt", async () => {
    await expect(
      runPullFromBytes(projectDir, Buffer.from("not-gzip"), {}),
    ).rejects.toThrow(PullVerifyError);
    expect(existsSync(join(projectDir, ".vibeflow", ".pull-tmp"))).toBe(false);
    expect(existsSync(join(projectDir, ".vibeflow", "tasks"))).toBe(false);
  });

  it("writes nothing when the manifest hash fails", async () => {
    const bytes = makeArchive([{ clientId: "a", record: taskRecord("a") }], [], {
      tasks: [{ cliId: "a", hash: "f".repeat(64) }],
    });
    await expect(runPullFromBytes(projectDir, bytes, {})).rejects.toThrow(
      PullVerifyError,
    );
    expect(existsSync(join(projectDir, ".vibeflow", "tasks"))).toBe(false);
  });

  it("cleans up the staging dir on success", async () => {
    const bytes = makeArchive([{ clientId: "a", record: taskRecord("a") }]);
    await runPullFromBytes(projectDir, bytes, {});
    const proto = join(projectDir, ".vibeflow");
    const leftovers = existsSync(proto)
      ? (await import("node:fs")).readdirSync(proto).filter((e) => e.startsWith(".pull-tmp"))
      : [];
    expect(leftovers).toEqual([]);
  });
});

describe("stagePullArchive — truncation", () => {
  it("refuses a tar without its end-of-archive blocks", async () => {
    const full = gzipSync(
      writeTar([{ path: "manifest.json", data: Buffer.from("{}") }]),
    );
    // A tar without its end blocks is corrupt: gzip of a truncated tar.
    const { gunzipSync: gunzip } = await import("node:zlib");
    const plain = gunzip(full);
    const truncated = plain.subarray(0, plain.length - 1024);
    const { gzipSync: gzip } = await import("node:zlib");
    await expect(stagePullArchive(projectDir, gzip(truncated))).rejects.toThrow(
      PullVerifyError,
    );
  });
});
