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
  readdirSync,
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

describe("mergePullRecord — status follows the remote record", () => {
  it("adopts the remote status by default, even when the local updated stamp is newer", () => {
    // Ticket d681603c: the lane set done online at 15:05; the local file was
    // rewritten later (16:31). Record timestamps are not consulted — the
    // board decides workflow state.
    const local = { id: "a", status: "todo", updated: "2026-10-22T16:31:40.021Z" };
    const remote = { id: "a", status: "done", updated: "2026-10-22T15:05:42.686Z" };
    const { merged, changed, conflict, statusAdopted } = mergePullRecord(
      local,
      remote,
      false,
    );
    expect(merged.status).toBe("done");
    expect(changed).toBe(true);
    expect(conflict).toBe(true);
    expect(statusAdopted).toBe(true);
  });

  it("--prefer-local keeps the local status like any other conflicting field", () => {
    const local = { id: "a", status: "todo" };
    const remote = { id: "a", status: "done" };
    const { merged, changed, conflict, statusAdopted } = mergePullRecord(
      local,
      remote,
      false,
      true,
    );
    expect(merged.status).toBe("todo");
    expect(changed).toBe(false);
    expect(conflict).toBe(true);
    expect(statusAdopted).toBe(false);
  });

  it("--prefer-remote still takes the remote status", () => {
    const { merged, changed, statusAdopted } = mergePullRecord(
      { id: "a", status: "todo" },
      { id: "a", status: "done" },
      true,
    );
    expect(merged.status).toBe("done");
    expect(changed).toBe(true);
    expect(statusAdopted).toBe(true);
  });

  it("--prefer-remote beats --prefer-local for status", () => {
    const { merged } = mergePullRecord(
      { id: "a", status: "todo" },
      { id: "a", status: "done" },
      true,
      true,
    );
    expect(merged.status).toBe("done");
  });

  it("an agreed status is a no-op and counts no adoption", () => {
    const { changed, conflict, statusAdopted } = mergePullRecord(
      { id: "a", status: "todo" },
      { id: "a", status: "todo" },
      false,
    );
    expect(changed).toBe(false);
    expect(conflict).toBe(false);
    expect(statusAdopted).toBe(false);
  });

  it("a missing local status is added, not adopted", () => {
    const { merged, changed, statusAdopted } = mergePullRecord(
      { id: "a" },
      { id: "a", status: "todo" },
      false,
    );
    expect(merged.status).toBe("todo");
    expect(changed).toBe(true);
    expect(statusAdopted).toBe(false);
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

  it("quarantines unknown local data: pull preserves exact bytes and reports a conflict", () => {
    writeTask("t1", taskRecord("t1", { localOnly: "deliberate", type: "Chore" }));
    const path = join(projectDir, ".vibeflow", "tasks", "2026-01-01", "t1.json");
    const before = readFileSync(path, "utf8");
    const summary = applyPullEntries(projectDir,
      stagingFor([{ clientId: "t1", record: taskRecord("t1", { title: "Remote" }) }]),
      { preferRemote: true });
    expect(summary.conflicts).toBe(1);
    expect(summary.merged).toBe(0);
    expect(summary.added).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

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
    writeTask("t1", taskRecord("t1", { baselineFile: "mine.png", title: "Local title" }));
    const record = taskRecord("t1", { title: "Local title", reportBack: true });
    const summary = applyPullEntries(
      projectDir,
      stagingFor([{ clientId: "t1", record: { ...record, title: "Remote title" } }]),
      {},
    );
    expect(summary.merged).toBe(1);
    expect(summary.added).toBe(0);
    expect(summary.conflicts).toBe(1);
    const stored = readStoredTask("t1");
    expect(stored.baselineFile).toBe("mine.png");
    expect(stored.reportBack).toBe(true);
    // Local wins: the title conflict kept the local value.
    expect(stored.title).toBe("Local title");
  });

  it("adopts a remote status into the stored record and counts it", () => {
    writeTask("t1", taskRecord("t1", { status: "todo" }));
    const summary = applyPullEntries(
      projectDir,
      stagingFor([{ clientId: "t1", record: taskRecord("t1", { status: "review" }) }]),
      {},
    );
    expect(summary.merged).toBe(1);
    expect(summary.statusAdopted).toBe(1);
    expect(readStoredTask("t1").status).toBe("review");
  });

  it("merges a record carrying files[].id (a37abf9f quarantine regression)", () => {
    // The server echoes its file row id into raw.files[]; the local clone
    // carries it too. The merge must adopt remote status on such a record
    // instead of quarantining it out of pull/push/listings (d681603c).
    const withId = taskRecord("t1", {
      status: "todo",
      files: [{ id: "gbfvlupweyuio4018i4xkdgi", name: "plan.md", addedAt: "2026-10-22T14:51:04.379Z" }],
    });
    writeTask("t1", withId);
    const summary = applyPullEntries(
      projectDir,
      stagingFor([{ clientId: "t1", record: taskRecord("t1", { status: "review" }) }]),
      {},
    );
    expect(summary.merged).toBe(1);
    expect(summary.statusAdopted).toBe(1);
    expect(readStoredTask("t1").status).toBe("review");
  });

  it("--prefer-local keeps the stored status", () => {
    writeTask("t1", taskRecord("t1", { status: "todo" }));
    const summary = applyPullEntries(
      projectDir,
      stagingFor([{ clientId: "t1", record: taskRecord("t1", { status: "review" }) }]),
      { preferLocal: true },
    );
    expect(summary.unchanged).toBe(1);
    expect(summary.statusAdopted).toBe(0);
    expect(readStoredTask("t1").status).toBe("todo");
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

describe("pull atomicity — apply verifies before the first write", () => {
  /** Snapshot every byte under .vibeflow: relative path → content hash. */
  function snapshotStore(): Map<string, string> {
    const root = join(projectDir, ".vibeflow");
    const out = new Map<string, string>();
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile()) {
          out.set(abs.slice(root.length + 1), sha256Hex(readFileSync(abs)));
        }
      }
    };
    walk(root);
    return out;
  }

  function expectStoreUnchanged(before: Map<string, string>): void {
    expect([...snapshotStore().entries()]).toEqual([...before.entries()]);
  }

  /** Task JSONs (not file blobs) whose bytes differ from the snapshot. */
  function changedTaskJsons(before: Map<string, string>): string[] {
    const after = snapshotStore();
    const changed: string[] = [];
    for (const [rel, hash] of after) {
      if (rel.startsWith("tasks/files/") || !rel.endsWith(".json")) continue;
      if (before.get(rel) !== hash) changed.push(rel);
    }
    for (const rel of before.keys()) {
      if (rel.startsWith("tasks/files/") || !rel.endsWith(".json")) continue;
      if (!after.has(rel)) changed.push(`${rel} (deleted)`);
    }
    return changed.sort();
  }

  function stagingWith(
    tasks: Array<{ clientId: string; record: Record<string, unknown> }>,
    files: PullStaging["files"],
    manifestFiles: PullManifest["files"],
    manifestTasks?: PullManifest["tasks"],
  ): PullStaging {
    return {
      manifest: {
        version: 1,
        taskCount: tasks.length,
        fileCount: files.length,
        tasks:
          manifestTasks ??
          tasks.map((t) => ({ cliId: t.clientId, hash: hashTaskRecord(t.record) })),
        files: manifestFiles,
      },
      tasks,
      files,
      missingBytes: [],
    };
  }

  it("a file sha mismatch throws before any task is written", () => {
    writeTask("e1", taskRecord("e1", { sortKey: "0001" }));
    const before = snapshotStore();
    // Two brand-new tasks a naive interleaved merge would write first; the
    // file bytes below do NOT match the manifest sha (same length, so only
    // the sha check fires).
    const n1 = taskRecord("n1", { sortKey: "0010" });
    const n2 = taskRecord("n2", { sortKey: "0011" });
    const good = Buffer.from("good bytes!");
    const bad = Buffer.from("xxxx bytes!");
    expect(good.length).toBe(bad.length);
    expect(sha256Hex(good)).not.toBe(sha256Hex(bad));
    const staging = stagingWith(
      [
        { clientId: "n1", record: n1 },
        { clientId: "n2", record: n2 },
      ],
      [{ clientId: "n1", name: "doc.txt", data: bad }],
      [{ cliId: "n1", name: "doc.txt", size: good.length, sha256: sha256Hex(good) }],
    );
    expect(() => applyPullEntries(projectDir, staging, {})).toThrow(PullVerifyError);
    // Zero writes: neither new task landed and the existing store is identical.
    expectStoreUnchanged(before);
    expect(
      existsSync(join(projectDir, ".vibeflow", "tasks", "2026-01-01", "n1.json")),
    ).toBe(false);
  });

  it("a task hash mismatch on the LAST task still writes nothing", () => {
    writeTask("e1", taskRecord("e1", { sortKey: "0001" }));
    const before = snapshotStore();
    const n1 = taskRecord("n1", { sortKey: "0010" });
    const n2 = taskRecord("n2", { sortKey: "0011" });
    const staging = stagingWith(
      [
        { clientId: "n1", record: n1 },
        { clientId: "n2", record: n2 },
      ],
      [],
      [],
      [
        { cliId: "n1", hash: hashTaskRecord(n1) },
        { cliId: "n2", hash: "f".repeat(64) },
      ],
    );
    expect(() => applyPullEntries(projectDir, staging, {})).toThrow(PullVerifyError);
    expectStoreUnchanged(before);
  });

  it("runPullFromBytes leaves a populated store byte-identical on verify failure", async () => {
    writeTask("e1", taskRecord("e1", { sortKey: "0001" }));
    const filesDir = join(projectDir, ".vibeflow", "tasks", "files", "e1");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "keep.txt"), "keep me");
    const before = snapshotStore();
    const ok = taskRecord("n1", { sortKey: "0010" });
    const tampered = taskRecord("n2", { sortKey: "0011" });
    const bytes = makeArchive(
      [
        { clientId: "n1", record: ok },
        { clientId: "n2", record: tampered },
      ],
      [],
      {
        tasks: [
          { cliId: "n1", hash: hashTaskRecord(ok) },
          { cliId: "n2", hash: "0".repeat(64) },
        ],
      },
    );
    await expect(runPullFromBytes(projectDir, bytes, {})).rejects.toThrow(
      PullVerifyError,
    );
    expectStoreUnchanged(before);
  });
});

describe("pull fidelity — the server record is reproduced, not reinvented", () => {
  it("an unchanged pull writes nothing: no invented mimeType, updated untouched", () => {
    const record = taskRecord("same-1", {
      sortKey: "0001",
      updated: "2026-03-03T00:00:00.000Z",
      files: [{ name: "note.txt", addedAt: "2026-01-01T00:00:00.000Z" }],
    });
    writeTask("same-1", record);
    const taskPath = join(projectDir, ".vibeflow", "tasks", "2026-01-01", "same-1.json");
    const filesDir = join(projectDir, ".vibeflow", "tasks", "files", "same-1");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "note.txt"), "same-bytes");
    const before = readFileSync(taskPath, "utf-8");
    // The server record carries NO mimeType; the manifest file entry does
    // (real exports do) — the pull must not invent it into the stored task.
    const data = Buffer.from("same-bytes");
    const staging: PullStaging = {
      manifest: {
        version: 1,
        taskCount: 1,
        fileCount: 1,
        tasks: [{ cliId: "same-1", hash: hashTaskRecord(record) }],
        files: [
          {
            cliId: "same-1",
            name: "note.txt",
            size: data.length,
            sha256: sha256Hex(data),
            mimeType: "text/plain",
          },
        ],
      },
      tasks: [{ clientId: "same-1", record: { ...record } }],
      files: [{ clientId: "same-1", name: "note.txt", data, mimeType: "text/plain" }],
      missingBytes: [],
    };
    const summary = applyPullEntries(projectDir, staging, {});
    expect(summary).toMatchObject({
      added: 0,
      merged: 0,
      unchanged: 1,
      filesWritten: 0,
      filesIdentical: 1,
      filesKept: 0,
    });
    // The task file is byte-identical: no invented key, no updated rewrite.
    expect(readFileSync(taskPath, "utf-8")).toBe(before);
    const stored = JSON.parse(before) as {
      updated?: string;
      files?: Array<{ mimeType?: string }>;
    };
    expect(stored.updated).toBe("2026-03-03T00:00:00.000Z");
    expect(stored.files ?? []).toHaveLength(1);
    expect("mimeType" in (stored.files?.[0] ?? {})).toBe(false);
  });
});

describe("pull honesty — the summary counts what was written", () => {
  it("added+merged equals the task files changed on disk", () => {
    const u1 = taskRecord("u1", {
      sortKey: "0001",
      updated: "2026-03-03T00:00:00.000Z",
      files: [{ name: "a.txt", addedAt: "2026-01-01T00:00:00.000Z" }],
    });
    writeTask("u1", u1);
    const u1Path = join(projectDir, ".vibeflow", "tasks", "2026-01-01", "u1.json");
    const u1BytesBefore = readFileSync(u1Path, "utf-8");
    const u1Dir = join(projectDir, ".vibeflow", "tasks", "files", "u1");
    mkdirSync(u1Dir, { recursive: true });
    writeFileSync(join(u1Dir, "a.txt"), "AAA");
    const m1 = taskRecord("m1", {
      sortKey: "0002",
      files: [{ name: "c.txt", addedAt: "2026-01-01T00:00:00.000Z" }],
    });
    writeTask("m1", m1);
    const m1Dir = join(projectDir, ".vibeflow", "tasks", "files", "m1");
    mkdirSync(m1Dir, { recursive: true });
    writeFileSync(join(m1Dir, "c.txt"), "local wins");
    // Count hashes before touching anything.
    const root = join(projectDir, ".vibeflow");
    const before = new Map<string, string>();
    const walk = (dir: string, into: Map<string, string>): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walk(abs, into);
        else if (entry.isFile()) {
          into.set(abs.slice(root.length + 1), sha256Hex(readFileSync(abs)));
        }
      }
    };
    walk(root, before);

    const m1Remote = { ...m1, reportBack: true };
    const n1 = taskRecord("n1", { sortKey: "0003" });
    const aData = Buffer.from("AAA");
    const bData = Buffer.from("brand new");
    const cData = Buffer.from("remote differs");
    const staging: PullStaging = {
      manifest: {
        version: 1,
        taskCount: 3,
        fileCount: 3,
        tasks: [
          { cliId: "m1", hash: hashTaskRecord(m1Remote) },
          { cliId: "n1", hash: hashTaskRecord(n1) },
          { cliId: "u1", hash: hashTaskRecord(u1) },
        ],
        files: [
          { cliId: "u1", name: "a.txt", size: aData.length, sha256: sha256Hex(aData), mimeType: "text/plain" },
          { cliId: "n1", name: "b.txt", size: bData.length, sha256: sha256Hex(bData), mimeType: "text/plain" },
          { cliId: "m1", name: "c.txt", size: cData.length, sha256: sha256Hex(cData) },
        ],
      },
      tasks: [
        { clientId: "m1", record: m1Remote },
        { clientId: "n1", record: n1 },
        { clientId: "u1", record: { ...u1 } },
      ],
      files: [
        { clientId: "u1", name: "a.txt", data: aData, mimeType: "text/plain" },
        { clientId: "n1", name: "b.txt", data: bData, mimeType: "text/plain" },
        { clientId: "m1", name: "c.txt", data: cData },
      ],
      missingBytes: [],
    };
    const summary = applyPullEntries(projectDir, staging, {});
    expect(summary.added).toBe(1);
    expect(summary.merged).toBe(1);
    expect(summary.unchanged).toBe(1);
    expect(summary.filesWritten).toBe(1);
    expect(summary.filesIdentical).toBe(1);
    expect(summary.filesKept).toBe(1);

    // Independently recount: the task JSONs changed on disk are exactly added+merged.
    const after = new Map<string, string>();
    walk(root, after);
    const changed: string[] = [];
    for (const [rel, hash] of after) {
      if (rel.startsWith("tasks/files/") || !rel.endsWith(".json")) continue;
      if (before.get(rel) !== hash) changed.push(rel);
    }
    expect(changed).toHaveLength(summary.added + summary.merged);
    // The unchanged task is byte-identical despite the manifest mimeType.
    expect(readFileSync(u1Path, "utf-8")).toBe(u1BytesBefore);
    // No stored record invented a mimeType the server record lacks.
    expect(readFileSync(u1Path, "utf-8")).not.toContain("mimeType");
  });
});

describe("pull linked/stale rule — the record decides what materialises", () => {
  const linkedRecord = (id: string, files: Array<Record<string, unknown>>) =>
    taskRecord(id, { sortKey: "0001", files });

  it("never writes bytes for a name the merged record covers with linkedPath", () => {
    // Bug-2 case 1 (795a42a5/verify-command.md): the record says the bytes
    // live outside the store. The disk lacks the file, so the old
    // disk-driven plan wrote it — inventing content no pull converges from.
    const record = linkedRecord("linked-1", [
      { name: "report.md", addedAt: "2026-01-01T00:00:00.000Z" },
      {
        name: "verify-command.md",
        addedAt: "2026-01-01T00:00:00.000Z",
        linkedPath: "docs/research/verify-command.md",
      },
    ]);
    writeTask("linked-1", record);
    const taskPath = join(projectDir, ".vibeflow", "tasks", "2026-01-01", "linked-1.json");
    const before = readFileSync(taskPath, "utf-8");
    const staged = Buffer.from("stale-bytes-that-must-never-land");
    const staging: PullStaging = {
      manifest: {
        version: 1,
        taskCount: 1,
        fileCount: 1,
        tasks: [{ cliId: "linked-1", hash: hashTaskRecord(record) }],
        files: [
          {
            cliId: "linked-1",
            name: "verify-command.md",
            size: staged.length,
            sha256: sha256Hex(staged),
          },
        ],
      },
      tasks: [{ clientId: "linked-1", record: { ...record } }],
      files: [{ clientId: "linked-1", name: "verify-command.md", data: staged }],
      missingBytes: [],
    };
    const summary = applyPullEntries(projectDir, staging, {});
    expect(summary).toMatchObject({
      unchanged: 1,
      filesWritten: 0,
      filesIdentical: 0,
      filesKept: 0,
      filesSkipped: 1,
    });
    // No byte written, no ref folded, no `updated` bump: byte-identical.
    expect(readFileSync(taskPath, "utf-8")).toBe(before);
    expect(
      existsSync(join(projectDir, ".vibeflow", "tasks", "files", "linked-1", "verify-command.md")),
    ).toBe(false);
  });

  it("never writes bytes for a staged file the record does not reference (stale row)", () => {
    // Bug-2 case 2 (7f0143c4/information_hmr-...): a stale server row under
    // a name no files[] entry references. The old plan wrote the bytes AND
    // folded a local-only ref the next verify flags as `file-missing-raw`.
    const record = linkedRecord("stale-1", [
      {
        name: "information/hmr-live-reload-research.md",
        addedAt: "2026-01-01T00:00:00.000Z",
        linkedPath: "information/hmr-live-reload-research.md",
      },
    ]);
    writeTask("stale-1", record);
    const taskPath = join(projectDir, ".vibeflow", "tasks", "2026-01-01", "stale-1.json");
    const before = readFileSync(taskPath, "utf-8");
    const staged = Buffer.from("stale-row-bytes");
    const staging: PullStaging = {
      manifest: {
        version: 1,
        taskCount: 1,
        fileCount: 1,
        tasks: [{ cliId: "stale-1", hash: hashTaskRecord(record) }],
        files: [
          {
            cliId: "stale-1",
            name: "information_hmr-live-reload-research.md",
            size: staged.length,
            sha256: sha256Hex(staged),
          },
        ],
      },
      tasks: [{ clientId: "stale-1", record: { ...record } }],
      files: [{ clientId: "stale-1", name: "information_hmr-live-reload-research.md", data: staged }],
      missingBytes: [],
    };
    const summary = applyPullEntries(projectDir, staging, {});
    expect(summary).toMatchObject({ unchanged: 1, filesWritten: 0, filesSkipped: 1 });
    expect(readFileSync(taskPath, "utf-8")).toBe(before);
    expect(
      existsSync(
        join(projectDir, ".vibeflow", "tasks", "files", "stale-1", "information_hmr-live-reload-research.md"),
      ),
    ).toBe(false);
  });

  it("skipping holds under --prefer-remote: the record overrules what exists", () => {
    const record = linkedRecord("linked-pr", [
      {
        name: "ext.md",
        addedAt: "2026-01-01T00:00:00.000Z",
        linkedPath: "/abs/ext.md",
      },
    ]);
    writeTask("linked-pr", record);
    const staged = Buffer.from("remote-bytes");
    const staging: PullStaging = {
      manifest: {
        version: 1,
        taskCount: 1,
        fileCount: 1,
        tasks: [{ cliId: "linked-pr", hash: hashTaskRecord(record) }],
        files: [{ cliId: "linked-pr", name: "ext.md", size: staged.length, sha256: sha256Hex(staged) }],
      },
      tasks: [{ clientId: "linked-pr", record: { ...record } }],
      files: [{ clientId: "linked-pr", name: "ext.md", data: staged }],
      missingBytes: [],
    };
    const summary = applyPullEntries(projectDir, staging, { preferRemote: true });
    expect(summary).toMatchObject({ filesWritten: 0, filesSkipped: 1 });
    expect(
      existsSync(join(projectDir, ".vibeflow", "tasks", "files", "linked-pr", "ext.md")),
    ).toBe(false);
  });

  it("a record with no files[] array is silent: staged files still materialise", () => {
    // Synthesised records (web-created tasks) carry no files[] key — the
    // silence must not read as disowning the staged bytes. New-task path:
    // the staged record is used verbatim, so no files[] array stays silent.
    const record = taskRecord("silent-1", { sortKey: "0001" });
    delete (record as Record<string, unknown>).files;
    const staged = Buffer.from("web-uploaded-bytes");
    const staging: PullStaging = {
      manifest: {
        version: 1,
        taskCount: 1,
        fileCount: 1,
        tasks: [{ cliId: "silent-1", hash: hashTaskRecord(record) }],
        files: [{ cliId: "silent-1", name: "w.md", size: staged.length, sha256: sha256Hex(staged) }],
      },
      tasks: [{ clientId: "silent-1", record: { ...record } }],
      files: [{ clientId: "silent-1", name: "w.md", data: staged }],
      missingBytes: [],
    };
    const summary = applyPullEntries(projectDir, staging, {});
    expect(summary).toMatchObject({ filesWritten: 1, filesSkipped: 0 });
    expect(
      readFileSync(join(projectDir, ".vibeflow", "tasks", "files", "silent-1", "w.md"), "utf-8"),
    ).toBe("web-uploaded-bytes");
  });

  it("manifest `linked: true` entries never materialise bytes (no object on the server)", () => {
    const record = linkedRecord("manifest-linked-1", [
      {
        name: "ext.md",
        addedAt: "2026-01-01T00:00:00.000Z",
        linkedPath: "/abs/ext.md",
      },
    ]);
    const staging: PullStaging = {
      manifest: {
        version: 1,
        taskCount: 1,
        fileCount: 1,
        tasks: [{ cliId: "manifest-linked-1", hash: hashTaskRecord(record) }],
        files: [{ cliId: "manifest-linked-1", name: "ext.md", size: 10, sha256: "x".repeat(64), linked: true }],
      },
      tasks: [{ clientId: "manifest-linked-1", record: { ...record } }],
      files: [],
      missingBytes: [{ cliId: "manifest-linked-1", name: "ext.md" }],
    };
    // Verification accepts the linked entry with zero tar bytes...
    verifyPullStaging(staging);
    const summary = applyPullEntries(projectDir, staging, {});
    // ...and the merge writes nothing for it.
    expect(summary).toMatchObject({
      added: 1,
      filesWritten: 0,
      filesSkipped: 0,
      missingBytes: 1,
    });
    expect(
      existsSync(join(projectDir, ".vibeflow", "tasks", "files", "manifest-linked-1")),
    ).toBe(false);
  });

  it("a sanctioned file still writes, and a re-pull counts it identical (counts equal reality)", () => {
    const record = linkedRecord("legit-1", [
      { name: "a.txt", addedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    writeTask("legit-1", record);
    const data = Buffer.from("legit-bytes");
    const staging: PullStaging = {
      manifest: {
        version: 1,
        taskCount: 1,
        fileCount: 1,
        tasks: [{ cliId: "legit-1", hash: hashTaskRecord(record) }],
        files: [{ cliId: "legit-1", name: "a.txt", size: data.length, sha256: sha256Hex(data) }],
      },
      tasks: [{ clientId: "legit-1", record: { ...record } }],
      files: [{ clientId: "legit-1", name: "a.txt", data }],
      missingBytes: [],
    };
    const first = applyPullEntries(projectDir, staging, {});
    expect(first).toMatchObject({ filesWritten: 1, filesSkipped: 0 });
    const second = applyPullEntries(projectDir, staging, {});
    expect(second).toMatchObject({ filesWritten: 0, filesIdentical: 1, filesSkipped: 0 });
    // Independently recount: exactly one new file on disk after both pulls.
    const filesDir = join(projectDir, ".vibeflow", "tasks", "files", "legit-1");
    expect(readdirSync(filesDir)).toEqual(["a.txt"]);
  });
});
