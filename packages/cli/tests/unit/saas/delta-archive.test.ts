import { describe, expect, it } from "vitest";

import {
  buildDeltaPlan,
  chunkDeltaPlan,
  type Inventory,
  type LocalTask,
} from "../../../src/saas/delta-archive";
import { hashTaskRecord, sha256Hex } from "@vibeflow-tools/shared/delta-hash";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function localTask(
  id: string,
  raw: unknown,
  files: { name: string; size: number; data: Uint8Array }[] = [],
): LocalTask {
  return { id, raw, files };
}

describe("buildDeltaPlan", () => {
  it("pushes a task the server has never seen", () => {
    const plan = buildDeltaPlan(
      [localTask("t1", { title: "new" })],
      { tasks: [], files: [] },
    );

    expect(plan.tasks.map((task) => task.id)).toEqual(["t1"]);
    expect(plan.unchangedTaskIds).toEqual([]);
    expect(plan.droppedFileCount).toBe(0);
  });

  it("skips an unchanged task regardless of key order", () => {
    const local = localTask("t1", { title: "same", count: 2 });
    const inventory: Inventory = {
      tasks: [
        { id: "t1", hash: hashTaskRecord({ count: 2, title: "same" }) },
      ],
      files: [],
    };

    const plan = buildDeltaPlan([local], inventory);

    expect(plan.tasks).toEqual([]);
    expect(plan.unchangedTaskIds).toEqual(["t1"]);
  });

  it("pushes a task whose record changed", () => {
    const plan = buildDeltaPlan(
      [localTask("t1", { title: "changed" })],
      { tasks: [{ id: "t1", hash: hashTaskRecord({ title: "original" }) }], files: [] },
    );

    expect(plan.tasks.map((task) => task.id)).toEqual(["t1"]);
    expect(plan.unchangedTaskIds).toEqual([]);
  });

  it("drops a legacy file matched by name and size", () => {
    const data = bytes("hello");
    const plan = buildDeltaPlan(
      [localTask("t1", { title: "x" }, [{ name: "a.txt", size: data.length, data }])],
      {
        tasks: [],
        files: [{ taskId: "t1", name: "a.txt", size: data.length, hash: null }],
      },
    );

    expect(plan.droppedFileCount).toBe(1);
    expect(plan.tasks[0].files).toEqual([
      { name: "a.txt", size: data.length, data: new Uint8Array(0) },
    ]);
  });

  it("pushes a same-name file with a different size", () => {
    const data = bytes("hello");
    const plan = buildDeltaPlan(
      [localTask("t1", { title: "x" }, [{ name: "a.txt", size: data.length, data }])],
      {
        tasks: [],
        files: [{ taskId: "t1", name: "a.txt", size: data.length + 1, hash: null }],
      },
    );

    expect(plan.droppedFileCount).toBe(0);
    expect(plan.tasks[0].files[0].data).toEqual(data);
  });

  it("pushes a same-name, same-size file with different bytes when the inventory has a hash", () => {
    const data = bytes("hello");
    const plan = buildDeltaPlan(
      [localTask("t1", { title: "x" }, [{ name: "a.txt", size: data.length, data }])],
      {
        tasks: [],
        files: [
          {
            taskId: "t1",
            name: "a.txt",
            size: data.length,
            hash: sha256Hex(bytes("other")),
          },
        ],
      },
    );

    expect(plan.droppedFileCount).toBe(0);
    expect(plan.tasks[0].files[0].data).toEqual(data);
  });

  it("drops a hashed file whose bytes match", () => {
    const data = bytes("hello");
    const plan = buildDeltaPlan(
      [localTask("t1", { title: "x" }, [{ name: "a.txt", size: data.length, data }])],
      {
        tasks: [],
        files: [
          {
            taskId: "t1",
            name: "a.txt",
            size: data.length,
            hash: sha256Hex(data),
          },
        ],
      },
    );

    expect(plan.droppedFileCount).toBe(1);
    expect(plan.tasks[0].files[0].data.length).toBe(0);
  });
});

describe("chunkDeltaPlan", () => {
  const makeTasks = (count: number): LocalTask[] =>
    Array.from({ length: count }, (_, i) =>
      localTask(`t${i}`, { title: `task ${i}` }, [
        { name: "a.txt", size: 3, data: bytes(`f${i}`) },
      ]),
    );

  it("returns no chunks for an empty plan", () => {
    expect(chunkDeltaPlan({ tasks: [], unchangedTaskIds: [], droppedFileCount: 0 })).toEqual([]);
  });

  it("returns a single chunk for one task", () => {
    const chunks = chunkDeltaPlan({
      tasks: makeTasks(1),
      unchangedTaskIds: [],
      droppedFileCount: 0,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].tasks).toHaveLength(1);
  });

  it("splits 250 tasks into 100/100/50", () => {
    const tasks = makeTasks(250);
    const chunks = chunkDeltaPlan({ tasks, unchangedTaskIds: [], droppedFileCount: 0 });

    expect(chunks.map((chunk) => chunk.tasks.length)).toEqual([100, 100, 50]);
    expect(chunks.flatMap((chunk) => chunk.tasks)).toEqual(tasks);
  });

  it("reproduces the original plan when chunks are concatenated", () => {
    const tasks = makeTasks(250);
    const plan: DeltaPlanLike = {
      tasks,
      unchangedTaskIds: [],
      droppedFileCount: 0,
    };
    const chunks = chunkDeltaPlan(plan);

    const merged = {
      tasks: chunks.flatMap((chunk) => chunk.tasks),
      unchangedTaskIds: [],
      droppedFileCount: chunks.reduce((sum, chunk) => sum + chunk.droppedFileCount, 0),
    };

    expect(merged).toEqual(plan);
  });
});

type DeltaPlanLike = ReturnType<typeof buildDeltaPlan>;

describe("determinism", () => {
  it("produces deep-equal output for the same input", () => {
    const local = [
      localTask("t1", { title: "a" }, [{ name: "a.txt", size: 5, data: bytes("hello") }]),
      localTask("t2", { title: "b" }),
    ];
    const inventory: Inventory = {
      tasks: [{ id: "t2", hash: hashTaskRecord({ title: "b" }) }],
      files: [
        { taskId: "t1", name: "a.txt", size: 5, hash: sha256Hex(bytes("hello")) },
      ],
    };

    expect(buildDeltaPlan(local, inventory)).toEqual(buildDeltaPlan(local, inventory));
    expect(chunkDeltaPlan(buildDeltaPlan(local, inventory))).toEqual(
      chunkDeltaPlan(buildDeltaPlan(local, inventory)),
    );
  });
});
