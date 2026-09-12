/**
 * Author attribution on the create / transition surfaces (core/operations).
 *
 * `author` must be populated from the resolved user identity so an
 * agent-created task matches a human-created one, and a transition must never
 * drop an existing author.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTask,
  updateTask,
  type OperationContext,
} from "../../src/core/operations.js";
import type { Task } from "../../src/core/types.js";

let projectDir: string;

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    projectDir,
    mode: "local",
    userId: "Agent Smith",
    ...overrides,
  };
}

/** Writes a task file directly, simulating a task that predates author stamping. */
function seedTaskWithoutAuthor(id: string, status: Task["status"]): void {
  const created = new Date().toISOString();
  const dateDir = join(projectDir, ".vibeflow", "tasks", created.slice(0, 10));
  mkdirSync(dateDir, { recursive: true });
  const task: Partial<Task> = {
    id,
    title: "Legacy task",
    description: "",
    status,
    selector: "/",
    created,
    comments: [],
    files: [],
  };
  writeFileSync(join(dateDir, `${id}.json`), JSON.stringify(task, null, 2));
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "author-ops-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("createTask author", () => {
  it("sets author from the resolved user identity", async () => {
    const result = await createTask(ctx(), {
      title: "New task",
      description: "",
    });
    expect(result.ok).toBe(true);
    expect(result.data?.author).toBe("Agent Smith");
  });
});

describe("updateTask author", () => {
  it("sets author when claiming (in-progress)", async () => {
    const created = await createTask(ctx(), {
      title: "Claim me",
      description: "",
    });
    const result = await updateTask(ctx(), {
      id: created.data!.id,
      status: "in-progress",
    });
    expect(result.data?.author).toBe("Agent Smith");
  });

  it("keeps an existing author on a non-claim transition", async () => {
    const created = await createTask(ctx({ userId: "Human User" }), {
      title: "Authored by a human",
      description: "",
    });
    const result = await updateTask(ctx(), {
      id: created.data!.id,
      status: "backlog",
    });
    expect(result.data?.author).toBe("Human User");
  });

  it("backfills a missing author on transition", async () => {
    seedTaskWithoutAuthor("legacy000000000000000000000000", "todo");
    const result = await updateTask(ctx(), {
      id: "legacy000000000000000000000000",
      status: "backlog",
    });
    expect(result.data?.author).toBe("Agent Smith");
  });
});
