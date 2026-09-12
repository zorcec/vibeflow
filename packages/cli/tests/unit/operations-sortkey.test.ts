/**
 * Sort-key hardening on the create surface (core/operations + MCP CreateTaskInput).
 *
 * Every created task must carry a well-formed sortKey even when the caller
 * omits it; an explicitly supplied sortKey must survive untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTask,
  CreateTaskInput,
  type OperationContext,
} from "../../src/core/operations.js";
import {
  writeSortKeyMinimal,
  updateTask,
  maxStoreSortKey,
} from "../../src/core/tasks.js";

let projectDir: string;

function ctx(): OperationContext {
  return { projectDir, mode: "local", userId: "Agent Smith" };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "sortkey-ops-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("CreateTaskInput sortKey", () => {
  it("accepts input without sortKey", () => {
    const parsed = CreateTaskInput.parse({ title: "No key" });
    expect(parsed.sortKey).toBeUndefined();
  });

  it("accepts an optional sortKey", () => {
    const parsed = CreateTaskInput.parse({
      title: "With key",
      sortKey: "0000000000000042",
    });
    expect(parsed.sortKey).toBe("0000000000000042");
  });
});

describe("createTask sortKey", () => {
  it("auto-assigns a well-formed key when omitted", async () => {
    const result = await createTask(ctx(), {
      title: "Auto key",
      description: "",
    });

    expect(result.ok).toBe(true);
    expect(result.data?.sortKey).toMatch(/^\d{16}$/);
  });

  it("preserves an explicitly supplied key", async () => {
    const supplied = "0000000000000042";
    const result = await createTask(ctx(), {
      title: "Explicit key",
      description: "",
      sortKey: supplied,
    });

    expect(result.data?.sortKey).toBe(supplied);
  });

  // Regression: commit 3e169ab seeded the constant `generateSortKeyBetween(null,
  // null)` = `0000000001000000`, so every create collided on one key and every
  // drag between two such cards mis-landed. Two creates must now differ.
  it("assigns two consecutive creates different, increasing keys", async () => {
    const first = await createTask(ctx(), { title: "First", description: "" });
    const second = await createTask(ctx(), {
      title: "Second",
      description: "",
    });

    expect(first.data?.sortKey).toMatch(/^\d{16}$/);
    expect(second.data?.sortKey).toMatch(/^\d{16}$/);
    expect(second.data?.sortKey).not.toBe(first.data?.sortKey);
    expect((second.data?.sortKey ?? "") > (first.data?.sortKey ?? "")).toBe(
      true,
    );
  });

  it("mints a key above the store's existing max key", async () => {
    const seeded = "0000000002000000";
    await createTask(ctx(), {
      title: "Seed at high key",
      description: "",
      sortKey: seeded,
    });

    const created = await createTask(ctx(), {
      title: "After high key",
      description: "",
    });

    expect((created.data?.sortKey ?? "") > seeded).toBe(true);
  });

  it("seeds the first task of an empty store with INITIAL_GAP", async () => {
    const first = await createTask(ctx(), { title: "First", description: "" });
    // Empty store → max is null → padKey(INITIAL_GAP); no collision possible.
    expect(first.data?.sortKey).toBe("0000000001000000");
  });
});

describe("writeSortKeyMinimal", () => {
  // A maintenance backfill must change only `sortKey`/`updated`. Routing it
  // through `updateTask` re-serialises via normalizeTask, which DROPS legacy
  // fields it does not model — it once destroyed 18 commit SHAs that lived only
  // in the legacy singleton `commit` string. These tests pin the difference so
  // the reindex command can never regress onto the ordinary write path.
  function seedLegacyTask(): string {
    const dir = join(projectDir, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "legacytask.json");
    writeFileSync(
      file,
      JSON.stringify(
        {
          id: "legacytask",
          title: "Legacy",
          description: "",
          status: "done",
          created: "2026-01-01T00:00:00.000Z",
          updated: "2026-01-02T00:00:00.000Z",
          commit: "abc123def456",
          reportBack: false,
          unknownField: "keep-me",
          comments: [],
          files: [],
        },
        null,
        2,
      ),
      "utf-8",
    );
    return file;
  }

  it("changes only sortKey/updated, preserving legacy and unknown fields", () => {
    const file = seedLegacyTask();

    const ok = writeSortKeyMinimal(
      projectDir,
      "legacytask",
      "0000000002000000",
    );
    expect(ok).toBe(true);

    const after = JSON.parse(readFileSync(file, "utf-8"));
    expect(after.sortKey).toBe("0000000002000000");
    expect(after.id).toBe("legacytask");
    expect(after.commit).toBe("abc123def456");
    expect(after.reportBack).toBe(false);
    expect(after.unknownField).toBe("keep-me");
  });

  it("documents the trap: updateTask drops the same legacy fields", () => {
    const file = seedLegacyTask();

    updateTask(projectDir, "legacytask", { sortKey: "0000000003000000" });

    const after = JSON.parse(readFileSync(file, "utf-8"));
    expect(after.sortKey).toBe("0000000003000000");
    expect(after.commit).toBeUndefined();
    expect(after.unknownField).toBeUndefined();
    expect(after.reportBack).toBeUndefined();
  });
});

describe("sortKey ceiling cache", () => {
  // createTask must not rescan the whole store per create (that was O(n²) and
  // blew the stress-test budget). It reads a monotonic sidecar ceiling instead.
  // Regression: a stale-low ceiling would re-create the constant-key collision.
  const sidecar = () => join(projectDir, ".vibeflow", ".sortkey-ceiling");

  it("seeds the sidecar on the first create and raises it on each next create", async () => {
    expect(existsSync(sidecar())).toBe(false);

    const first = await createTask(ctx(), { title: "First", description: "" });
    expect(existsSync(sidecar())).toBe(true);
    expect(readFileSync(sidecar(), "utf-8")).toBe(first.data?.sortKey);

    const second = await createTask(ctx(), {
      title: "Second",
      description: "",
    });
    expect((second.data?.sortKey ?? "") > (first.data?.sortKey ?? "")).toBe(
      true,
    );
    expect(readFileSync(sidecar(), "utf-8")).toBe(second.data?.sortKey);
  });

  it("rescans the true store max when the sidecar is missing or corrupt", async () => {
    const seeded = await createTask(ctx(), { title: "Seed", description: "" });

    rmSync(sidecar());
    expect(maxStoreSortKey(projectDir)).toBe(seeded.data?.sortKey);

    writeFileSync(sidecar(), "not-a-key", "utf-8");
    expect(maxStoreSortKey(projectDir)).toBe(seeded.data?.sortKey);
  });

  it("never mints a key below a higher key written by an update", async () => {
    await createTask(ctx(), { title: "Base", description: "" });
    // A drag that appends to the bottom writes a key above the ceiling.
    const high = await createTask(ctx(), {
      title: "High",
      description: "",
      sortKey: "0000000009000000",
    });
    updateTask(projectDir, high.data!.id, {
      sortKey: "0000000009900000",
    });

    const next = await createTask(ctx(), { title: "Next", description: "" });
    expect((next.data?.sortKey ?? "") > "0000000009900000").toBe(true);
  });
});
