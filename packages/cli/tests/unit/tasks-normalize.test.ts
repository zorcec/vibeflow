/**
 * Store schema boundary: `type` allowlist, stray `links`, and
 * `tasks --normalize` (plan/apply).
 *
 * Pins the 1-1 local↔cloud convergence contract: a garbage local value
 * must read as absent and must not survive a normalising write, the
 * maintenance command heals existing records without touching anything
 * else, and a clean record normalises to itself hash-identically.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashTaskRecord } from "@vibeflow-tools/shared/delta-hash";
import {
  readTaskFile,
  updateTask,
  planTaskStoreNormalize,
  applyTaskStoreNormalize,
  normalizeTaskTypeValue,
  normalizeTaskLinksValue,
  shouldDropTypeValue,
} from "../../src/core/tasks.js";

function writeRawTask(
  projectDir: string,
  date: string,
  raw: Record<string, unknown>,
): string {
  const dir = join(projectDir, ".vibeflow", "tasks", date);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${raw.id}.json`);
  writeFileSync(filePath, JSON.stringify(raw, null, 2), "utf-8");
  return filePath;
}

function cleanRaw(id = "clean-record-id-00000000000001"): Record<string, unknown> {
  return {
    id,
    title: "Clean task",
    description: "A record with a valid type, a priority, and no junk.",
    status: "todo",
    url: "https://example.com/page",
    selector: "#app",
    cssSelector: "#app > button",
    type: "Bug",
    priority: "High",
    author: "agent",
    commits: [],
    created: "2026-03-25T10:00:00.000Z",
    updated: "2026-03-26T10:00:00.000Z",
    comments: [],
    files: [],
    sortKey: "0000000001000000",
  };
}

describe("normalizeTaskTypeValue (store schema boundary)", () => {
  it("keeps each documented value byte-identical", () => {
    for (const t of ["Task", "Bug", "Feature", "Enhancement", "Research"]) {
      expect(normalizeTaskTypeValue(t)).toBe(t);
    }
  });

  it("treats a stringified object as absent", () => {
    expect(normalizeTaskTypeValue("[object Object]")).toBeUndefined();
    expect(normalizeTaskTypeValue("[object Foo]")).toBeUndefined();
  });

  it("treats empty/whitespace/non-string values as absent", () => {
    for (const junk of ["", "   ", 42, true, null, undefined, {}, []]) {
      expect(normalizeTaskTypeValue(junk)).toBeUndefined();
    }
  });

  it("keeps a user-written label verbatim (free-form type, including spacing)", () => {
    // The convergence contract: a label the user deliberately wrote must
    // survive read → push → pull byte-identical, even when no picker or
    // filter names it. Only stringification garbage reads as absent.
    expect(normalizeTaskTypeValue("Chore")).toBe("Chore");
    expect(normalizeTaskTypeValue("Foo")).toBe("Foo");
    expect(normalizeTaskTypeValue("bug")).toBe("bug");
    expect(normalizeTaskTypeValue("TASK")).toBe("TASK");
    expect(normalizeTaskTypeValue("  Chore  ")).toBe("  Chore  ");
  });
});

describe("shouldDropTypeValue (--normalize deletion rule)", () => {
  it("drops artifacts, empties, and non-strings", () => {
    for (const v of [
      "[object Object]",
      "[object Foo]",
      "",
      "   ",
      42,
      true,
      {},
      [],
      null,
    ]) {
      expect(shouldDropTypeValue(v)).toBe(true);
    }
  });

  it("keeps valid values and possibly-deliberate labels", () => {
    for (const v of [
      "Task",
      "Bug",
      "Feature",
      "Enhancement",
      "Research",
      "Chore",
      "Foo",
    ]) {
      expect(shouldDropTypeValue(v)).toBe(false);
    }
  });
});

describe("normalizeTaskLinksValue (store schema boundary)", () => {
  it("keeps a non-empty valid link list", () => {
    const links = [{ taskId: "abc123", type: "parent" }];
    expect(normalizeTaskLinksValue(links)).toEqual(links);
  });

  it("treats an empty array, a non-array, and an all-invalid array as absent", () => {
    expect(normalizeTaskLinksValue([])).toBeUndefined();
    expect(normalizeTaskLinksValue("https://example.com")).toBeUndefined();
    expect(normalizeTaskLinksValue(null)).toBeUndefined();
    expect(normalizeTaskLinksValue(undefined)).toBeUndefined();
    expect(
      normalizeTaskLinksValue([{ taskId: "", type: "parent" }]),
    ).toBeUndefined();
  });
});

describe("readTaskFile schema boundary", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-normalize-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads a stringified-object type as ABSENT (no key at all)", () => {
    const filePath = writeRawTask(tempDir, "2026-03-25", {
      ...cleanRaw("9d84ac1c"),
      type: "[object Object]",
    });
    const task = readTaskFile(filePath);
    expect(task).not.toBeNull();
    expect(task!.type).toBeUndefined();
    expect("type" in task!).toBe(false);
  });

  it("reads an empty links array as ABSENT (no key at all)", () => {
    const filePath = writeRawTask(tempDir, "2026-05-24", {
      ...cleanRaw("69051081c1e803b9e47e7ca4964c32"),
      links: [],
    });
    const task = readTaskFile(filePath);
    expect(task).not.toBeNull();
    expect(task!.links).toBeUndefined();
    expect("links" in task!).toBe(false);
  });

  it("a garbage value never round-trips back out through a normalising write", () => {
    const filePath = writeRawTask(tempDir, "2026-03-25", {
      ...cleanRaw("9d84ac1c"),
      type: "[object Object]",
      links: [],
    });
    const updated = updateTask(tempDir, "9d84ac1c", {
      title: "Edited title",
    });
    expect(updated).not.toBeNull();
    expect("type" in updated!).toBe(false);
    expect("links" in updated!).toBe(false);
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect("type" in raw).toBe(false);
    expect("links" in raw).toBe(false);
  });

  it("a clean record normalises to itself, hash-identical", () => {
    const raw = cleanRaw();
    const filePath = writeRawTask(tempDir, "2026-03-25", raw);
    const task = readTaskFile(filePath);
    expect(task).not.toBeNull();
    expect(hashTaskRecord(task)).toBe(hashTaskRecord(raw));
    // Same keys, same values — normalization changed nothing.
    expect(task).toEqual(raw);
  });

  it("reads a user-written label verbatim (round-trips, hash-identical)", () => {
    // Bug-1 regression: `Chore` reached the server as absent because the
    // reader discarded it, so push could never converge (`raw.type` null
    // forever). The label must survive read → push → pull byte-identical.
    const raw = { ...cleanRaw("chore-roundtrip-00000001"), type: "Chore" };
    const filePath = writeRawTask(tempDir, "2026-09-13", raw);
    const task = readTaskFile(filePath);
    expect(task).not.toBeNull();
    expect(task!.type).toBe("Chore");
    expect(hashTaskRecord(task)).toBe(hashTaskRecord(raw));
  });

  it("an unknown label survives a normalising write", () => {
    // updateTask re-files by the record's created date (2026-03-25 in the
    // fixture), so seed that subdir for the re-read below.
    const filePath = writeRawTask(tempDir, "2026-03-25", {
      ...cleanRaw("chore-write-000000000001"),
      type: "Chore",
    });
    const updated = updateTask(tempDir, "chore-write-000000000001", {
      title: "Edited title",
    });
    expect(updated).not.toBeNull();
    expect(updated!.type).toBe("Chore");
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(raw.type).toBe("Chore");
  });

  it("preserves fields outside the boundary vocabulary (legacy `commit`)", () => {
    const raw = { ...cleanRaw("9d84ac1c"), commit: "deadbeefcafe" };
    const filePath = writeRawTask(tempDir, "2026-03-25", raw);
    const task = readTaskFile(filePath);
    expect((task as unknown as Record<string, unknown>).commit).toBe(
      "deadbeefcafe",
    );
  });
});

describe("planTaskStoreNormalize / applyTaskStoreNormalize", () => {
  let tempDir: string;

  const seedDirtyStore = (): string[] => {
    const before: string[] = [];
    const files = [
      writeRawTask(tempDir, "2026-03-25", {
        ...cleanRaw("9d84ac1c00000000000000000001"),
        type: "[object Object]",
        commit: "aaa111",
      }),
      writeRawTask(tempDir, "2026-03-26", {
        ...cleanRaw("89db6b9000000000000000000002"),
        type: "[object Object]",
      }),
      writeRawTask(tempDir, "2026-05-24", {
        ...cleanRaw("69051081c1e803b9e47e7ca4964c32"),
        links: [],
      }),
      writeRawTask(tempDir, "2026-09-09", {
        ...cleanRaw("78b9957449275b9101f5a02b5fa9da"),
        links: [],
      }),
      writeRawTask(tempDir, "2026-03-25", cleanRaw("untouched-clean-00000001")),
      writeRawTask(tempDir, "2026-03-25", {
        ...cleanRaw("null-type-stays-000000000001"),
        type: null,
      }),
      writeRawTask(tempDir, "2026-03-25", {
        ...cleanRaw("valid-links-stay-00000000001"),
        links: [{ taskId: "some-parent-id", type: "parent" }],
      }),
      // Possibly-deliberate label: reads as absent, never deleted.
      writeRawTask(tempDir, "2026-09-13", {
        ...cleanRaw("chore-label-stays-0000000001"),
        type: "Chore",
      }),
    ];
    for (const f of files) before.push(readFileSync(f, "utf-8"));
    return before;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-normalize-apply-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("dry-run plans the junk and writes nothing", () => {
    const before = seedDirtyStore();
    const report = planTaskStoreNormalize(tempDir);
    expect(report.changes.map((c) => c.id).sort()).toEqual(
      [
        "69051081c1e803b9e47e7ca4964c32",
        "78b9957449275b9101f5a02b5fa9da",
        "89db6b9000000000000000000002",
        "9d84ac1c00000000000000000001",
        "null-type-stays-000000000001",
      ].sort(),
    );
    for (const p of report.changes) {
      for (const c of p.changes) expect(c.after).toBe("absent");
    }
    // Untouched: clean record, valid parent link,
    // possibly-deliberate label.
    expect(
      report.changes.some((c) => c.id === "untouched-clean-00000001"),
    ).toBe(false);
    expect(
      report.changes.some((c) => c.id === "null-type-stays-000000000001"),
    ).toBe(true);
    expect(
      report.changes.some((c) => c.id === "valid-links-stay-00000000001"),
    ).toBe(false);
    expect(
      report.changes.some((c) => c.id === "chore-label-stays-0000000001"),
    ).toBe(false);
    // Nothing written: every file byte-identical.
    const dir = join(tempDir, ".vibeflow", "tasks");
    const after: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".json")) after.push(readFileSync(p, "utf-8"));
      }
    };
    walk(dir);
    expect(after.sort()).toEqual(before.sort());
  });

  it("--apply heals the junk, preserves everything else, and is idempotent", () => {
    seedDirtyStore();
    const first = applyTaskStoreNormalize(tempDir);
    expect(first.unwritten).toEqual([]);
    expect(first.applied.map((p) => p.id).sort()).toEqual(
      [
        "69051081c1e803b9e47e7ca4964c32",
        "78b9957449275b9101f5a02b5fa9da",
        "89db6b9000000000000000000002",
        "9d84ac1c00000000000000000001",
        "null-type-stays-000000000001",
      ].sort(),
    );

    // Healed: keys gone from disk.
    const healed = JSON.parse(
      readFileSync(
        join(
          tempDir,
          ".vibeflow",
          "tasks",
          "2026-03-25",
          "9d84ac1c00000000000000000001.json",
        ),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect("type" in healed).toBe(false);
    // ...while a field the tool does not understand survives byte-for-byte.
    expect(healed.commit).toBe("aaa111");
    expect(healed.priority).toBe("High");

    const linksHealed = JSON.parse(
      readFileSync(
        join(
          tempDir,
          ".vibeflow",
          "tasks",
          "2026-05-24",
          "69051081c1e803b9e47e7ca4964c32.json",
        ),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect("links" in linksHealed).toBe(false);

    // Idempotent: the second run plans and writes zero changes.
    expect(planTaskStoreNormalize(tempDir).changes).toEqual([]);
    const second = applyTaskStoreNormalize(tempDir);
    expect(second.applied).toEqual([]);
    expect(second.unwritten).toEqual([]);
  });
});
