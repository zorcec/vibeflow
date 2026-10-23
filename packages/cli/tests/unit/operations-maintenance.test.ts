/**
 * Maintenance operation pins (ticket 4a5f7df6, P5 step 7).
 *
 * `normalizeTaskStore` and `reindexTaskSortKeys` are CLI-only local
 * maintenance (no MCP tools, no cloud normalization), driven here in local
 * mode against throwaway stores plus injected port fakes:
 *
 * - normalize preview plans repairs and writes nothing; apply heals; a
 *   second apply plans zero (idempotence);
 * - `--apply --dry-run` is a preview (dryRun overrides apply — the one
 *   deliberate flip off the inline branch, which wrote through);
 * - a plan that lands zero writes is NORMALIZE_WRITE_FAILED;
 * - a partial apply is ok:true with a NORMALIZE_PARTIAL notice (never a
 *   total failure after a partial save);
 * - reindex previews without writing and without a manifest; a live run
 *   re-keys only the unordered (duplicates), preserves legacy fields, writes
 *   the manifest, and a second run plans zero (no remint of healthy keys,
 *   no manifest clobber);
 * - injected write failures map to REINDEX_WRITE_FAILED (all fail) or
 *   ok:true with counts (partial) — never a total failure after a partial
 *   save.
 *
 * The helper-level behaviour underneath (plan/apply/backfill/minimal write)
 * stays pinned without edits by
 * tests/unit/operations-p5-characterization.test.ts. The CLI envelopes, exit
 * codes and human blocks over these results are pinned by
 * tests/e2e/tasks-json-refusals.test.ts (reindex) and the normalize CLI
 * paths.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OperationContext } from "../../src/core/operations.js";
import {
  normalizeTaskStore,
  reindexTaskSortKeys,
} from "../../src/core/operations.js";
import type { TaskStore } from "../../src/core/task-store.js";
import { localTaskStore } from "../../src/core/task-store.js";

let projectDir: string;
let ctx: OperationContext;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "p5-maint-"));
  ctx = { projectDir, mode: "local" };
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function seedTask(task: Record<string, unknown>): void {
  const dir = join(projectDir, ".vibeflow", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${task.id as string}.json`),
    JSON.stringify(task, null, 2) + "\n",
  );
}

function baseTask(
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    comments: [],
    files: [],
    ...extra,
  };
}

function manifestPath(): string {
  return join(projectDir, ".vibeflow", "reindex-sort-keys-manifest.json");
}

describe("normalizeTaskStore", () => {
  it("preview plans repairs and writes nothing", async () => {
    seedTask({ ...baseTask("messy1"), description: null });
    const p = join(projectDir, ".vibeflow", "tasks", "messy1.json");
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    delete raw.status;
    writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");
    const bytesBefore = readFileSync(p, "utf-8");

    const r = await normalizeTaskStore(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok || !r.data.dryRun) expect.unreachable("expected a preview");
    else {
      expect(r.data.plans.length).toBe(1);
      expect(r.data.plans[0].id).toBe("messy1");
      expect(r.data.unwritten).toEqual([]);
    }
    expect(readFileSync(p, "utf-8")).toBe(bytesBefore);
  });

  it("apply heals and a second apply plans zero", async () => {
    seedTask({ ...baseTask("messy2"), description: null });
    const p = join(projectDir, ".vibeflow", "tasks", "messy2.json");
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    delete raw.status;
    writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");

    const applied = await normalizeTaskStore(ctx, { apply: true });
    expect(applied.ok).toBe(true);
    if (!applied.ok || applied.data.dryRun)
      expect.unreachable("expected a live apply");
    else {
      expect(applied.data.plans.length).toBe(1);
      expect(applied.data.unwritten).toEqual([]);
      expect(applied.data.notices).toEqual([]);
    }
    const healed = JSON.parse(readFileSync(p, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(healed.status).toBe("todo");

    const again = await normalizeTaskStore(ctx, {});
    expect(again.ok).toBe(true);
    if (!again.ok || !again.data.dryRun)
      expect.unreachable("expected a preview");
    else expect(again.data.plans).toEqual([]);
  });

  it("--apply --dry-run is a preview: dryRun overrides apply", async () => {
    seedTask({ ...baseTask("messy3"), description: null });
    const p = join(projectDir, ".vibeflow", "tasks", "messy3.json");
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    delete raw.status;
    writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");
    const bytesBefore = readFileSync(p, "utf-8");

    const r = await normalizeTaskStore(ctx, { apply: true, dryRun: true });
    expect(r.ok).toBe(true);
    if (!r.ok) expect.unreachable("expected ok");
    else expect(r.data.dryRun).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe(bytesBefore);
  });

  it("a plan that lands zero writes is NORMALIZE_WRITE_FAILED", async () => {
    // Injected store: the plan names a repair the apply cannot land.
    const fake = {
      planNormalize: async () => ({
        changes: [
          {
            id: "stuck1",
            filePath: join(projectDir, ".vibeflow", "tasks", "stuck1.json"),
            changes: [{ rule: "fill", field: "status", after: "todo" }],
          },
        ],
        unreadable: [],
        quarantined: [],
      }),
      applyNormalize: async () => ({
        applied: [],
        unwritten: ["stuck1"],
        unreadable: [],
        quarantined: [],
      }),
    } as unknown as TaskStore;
    const r = await normalizeTaskStore(
      { projectDir, mode: "local", store: fake },
      { apply: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NORMALIZE_WRITE_FAILED");
      expect(r.error.message).toContain("wrote 0 of 1");
      expect(r.error.suggestion).toContain("stuck1");
    }
  });

  it("a partial apply is ok:true with a NORMALIZE_PARTIAL notice", async () => {
    const fake = {
      planNormalize: async () => ({
        changes: [
          {
            id: "ok1",
            filePath: join(projectDir, ".vibeflow", "tasks", "ok1.json"),
            changes: [{ rule: "fill", field: "status", after: "todo" }],
          },
          {
            id: "stuck2",
            filePath: join(projectDir, ".vibeflow", "tasks", "stuck2.json"),
            changes: [{ rule: "fill", field: "status", after: "todo" }],
          },
        ],
        unreadable: [],
        quarantined: [],
      }),
      applyNormalize: async () => ({
        applied: [
          {
            id: "ok1",
            filePath: join(projectDir, ".vibeflow", "tasks", "ok1.json"),
            changes: [{ rule: "fill", field: "status", after: "todo" }],
          },
        ],
        unwritten: ["stuck2"],
        unreadable: [],
        quarantined: [],
      }),
    } as unknown as TaskStore;
    const r = await normalizeTaskStore(
      { projectDir, mode: "local", store: fake },
      { apply: true },
    );
    // The write landed, so this is success with a notice — never a total
    // failure after a partial save.
    expect(r.ok).toBe(true);
    if (!r.ok || r.data.dryRun) expect.unreachable("expected a live apply");
    else {
      expect(r.data.plans.length).toBe(1);
      expect(r.data.unwritten).toEqual(["stuck2"]);
      expect(r.data.notices.map((n) => n.code)).toEqual(["NORMALIZE_PARTIAL"]);
    }
  });
});

describe("reindexTaskSortKeys", () => {
  it("dry-run reports patches with zero effects and no manifest", async () => {
    seedTask(baseTask("dup1", { sortKey: "100" }));
    seedTask(baseTask("dup2", { sortKey: "100" }));
    const before1 = readFileSync(
      join(projectDir, ".vibeflow", "tasks", "dup1.json"),
      "utf-8",
    );
    const r = await reindexTaskSortKeys(ctx, { dryRun: true });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.data.dryRun) expect.unreachable("expected a preview");
    else {
      expect(r.data.patches.length).toBeGreaterThan(0);
      // The preview names titles for the human lines; the manifest shape
      // (id/oldKey/newKey) is what the JSON document carries.
      for (const patch of r.data.patches) {
        expect(typeof patch.title).toBe("string");
        expect(typeof patch.newKey).toBe("string");
      }
      expect(r.data.written).toBe(0);
    }
    expect(
      readFileSync(join(projectDir, ".vibeflow", "tasks", "dup1.json"), "utf-8"),
    ).toBe(before1);
    expect(existsSync(manifestPath())).toBe(false);
  });

  it("live re-keys duplicates minimally; second run plans zero", async () => {
    seedTask(baseTask("dup1", { sortKey: "100", updated: "2026-01-01T00:00:00.000Z" }));
    seedTask({
      ...baseTask("dup2", { sortKey: "100", updated: "2026-01-01T00:00:00.000Z" }),
      commit: "deadbeef",
    } as Record<string, unknown>);
    const r = await reindexTaskSortKeys(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok || r.data.dryRun) expect.unreachable("expected a live run");
    else {
      expect(r.data.written).toBeGreaterThan(0);
      expect(r.data.reindexVerified).toBe(true);
      expect(r.data.notices).toEqual([]);
    }
    // Minimal write: the legacy singleton `commit` field survives.
    const dup2rec = JSON.parse(
      readFileSync(join(projectDir, ".vibeflow", "tasks", "dup2.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(dup2rec.commit).toBe("deadbeef");
    // Manifest records the apply in the file shape (no titles).
    expect(existsSync(manifestPath())).toBe(true);
    const manifest = JSON.parse(
      readFileSync(manifestPath(), "utf-8"),
    ) as { patches: Array<Record<string, unknown>> };
    expect(manifest.patches.length).toBeGreaterThan(0);
    for (const patch of manifest.patches) {
      expect(Object.keys(patch).sort()).toEqual(["id", "newKey", "oldKey"]);
    }
    // Idempotence: a second run plans zero and leaves the manifest alone.
    const manifestBefore = readFileSync(manifestPath(), "utf-8");
    const again = await reindexTaskSortKeys(ctx, { dryRun: true });
    expect(again.ok).toBe(true);
    if (!again.ok || !again.data.dryRun)
      expect.unreachable("expected a preview");
    else expect(again.data.patches).toEqual([]);
    expect(readFileSync(manifestPath(), "utf-8")).toBe(manifestBefore);
  });

  it("a well-formed store is untouched: zero patches, no manifest", async () => {
    seedTask(baseTask("a", { sortKey: "100" }));
    seedTask(baseTask("b", { sortKey: "200" }));
    const live = await reindexTaskSortKeys(ctx, {});
    expect(live.ok).toBe(true);
    if (!live.ok || live.data.dryRun) expect.unreachable("expected live");
    else {
      // Well-formed unique keys are anchors — never reminted.
      expect(live.data.written).toBe(0);
      expect(live.data.patches).toEqual([]);
    }
    expect(existsSync(manifestPath())).toBe(false);
  });

  it("injected total write failure is REINDEX_WRITE_FAILED with no manifest", async () => {
    seedTask(baseTask("orphan1", { sortKey: "100" }));
    seedTask(baseTask("orphan2", { sortKey: "100" }));
    const before1 = readFileSync(
      join(projectDir, ".vibeflow", "tasks", "orphan1.json"),
      "utf-8",
    );
    const fake = {
      listTasks: (dir: string) => localTaskStore.listTasks(dir),
      writeSortKey: async () => false,
    } as unknown as TaskStore;
    const r = await reindexTaskSortKeys(
      { projectDir, mode: "local", store: fake },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REINDEX_WRITE_FAILED");
      expect(r.error.message).toContain("wrote 0 of");
    }
    expect(
      readFileSync(
        join(projectDir, ".vibeflow", "tasks", "orphan1.json"),
        "utf-8",
      ),
    ).toBe(before1);
    expect(existsSync(manifestPath())).toBe(false);
  });

  it("an injected partial write is ok:true with counts, never a total failure", async () => {
    seedTask(baseTask("p1", { sortKey: "100", updated: "2026-01-01T00:00:00.000Z" }));
    seedTask(baseTask("p2", { sortKey: "100", updated: "2026-01-01T00:00:00.000Z" }));
    let calls = 0;
    const fake = {
      listTasks: (dir: string) => localTaskStore.listTasks(dir),
      writeSortKey: async () => {
        calls += 1;
        return calls === 1;
      },
    } as unknown as TaskStore;
    const preview = await reindexTaskSortKeys(
      { projectDir, mode: "local", store: fake },
      { dryRun: true },
    );
    expect(preview.ok).toBe(true);
    const patchCount =
      preview.ok && preview.data.dryRun ? preview.data.patches.length : 0;
    expect(patchCount).toBeGreaterThan(0);
    const r = await reindexTaskSortKeys(
      { projectDir, mode: "local", store: fake },
      {},
    );
    // One write landed, so this is success — a total failure here would
    // claim nothing happened when a key did move.
    expect(r.ok).toBe(true);
    if (!r.ok || r.data.dryRun) expect.unreachable("expected a live run");
    else expect(r.data.written).toBe(1);
  });
});
