import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEMO_SEED_VERSION,
  countStoredTasks,
  maybeSeedEmptyProject,
  resolveDemoRoot,
  seedDemoBoard,
} from "../../src/core/demo-board.js";

const roots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibeflow-demo-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readTasks(root: string): Array<Record<string, unknown>> {
  const tasksDir = join(root, ".vibeflow", "tasks");
  const out: Array<Record<string, unknown>> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".json")) {
        out.push(JSON.parse(readFileSync(join(dir, entry.name), "utf8")) as Record<string, unknown>);
      }
    }
  };
  if (existsSync(tasksDir)) walk(tasksDir);
  return out;
}

describe("vibeflow demo — local seeded demo board (ticket ec65a901)", () => {
  it("resolves a fixed demo root outside any project, overridable by env", () => {
    const root = resolveDemoRoot({});
    expect(root.endsWith(join(homedir(), ".vibeflow-demo"))).toBe(true);
    expect(root.startsWith(process.cwd())).toBe(false);
    expect(resolveDemoRoot({ VIBEFLOW_DEMO_DIR: "/tmp/custom-demo" })).toBe("/tmp/custom-demo");
  });

  it("seeds a populated board covering every status, with an annotated hero and children", () => {
    const root = freshRoot();
    const result = seedDemoBoard(root);

    expect(result.seeded).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(10);

    const tasks = readTasks(root);
    const statuses = new Set(tasks.map((t) => String(t.status)));
    for (const status of ["backlog", "todo", "in-progress", "review", "done"]) {
      expect(statuses.has(status)).toBe(true);
    }

    const annotated = tasks.filter((t) => typeof t.url === "string" && t.url.length > 0);
    expect(annotated.length).toBeGreaterThanOrEqual(1);
    expect(String(annotated[0]?.selector ?? "").startsWith("#")).toBe(true);

    const withParentLink = tasks.filter((t) =>
      Array.isArray(t.links) && (t.links as Array<{ type?: string }>).some((l) => l.type === "parent"),
    );
    expect(withParentLink.length).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent — a second run with the same version writes nothing", () => {
    const root = freshRoot();
    const first = seedDemoBoard(root);
    const second = seedDemoBoard(root);

    expect(first.seeded).toBe(true);
    expect(second.seeded).toBe(false);
    expect(second.count).toBe(first.count);
    expect(readTasks(root)).toHaveLength(first.count);
  });

  it("--reset reseeds, and a version bump forces a reseed without duplicating cards", () => {
    const root = freshRoot();
    const first = seedDemoBoard(root);

    const reset = seedDemoBoard(root, { reset: true });
    expect(reset.seeded).toBe(true);
    expect(reset.count).toBe(first.count);

    // Simulate an older marker: same path, stale version → reseed, not append.
    writeFileSync(
      join(root, ".vibeflow", "demo-seed.json"),
      JSON.stringify({ version: DEMO_SEED_VERSION - 1 }),
    );
    const bumped = seedDemoBoard(root);
    expect(bumped.seeded).toBe(true);
    expect(bumped.count).toBe(first.count);
  });

  it("never writes outside the demo root it was given", () => {
    const root = freshRoot();
    const outside = freshRoot();
    mkdirSync(join(outside, ".vibeflow", "tasks"), { recursive: true });
    const before = readdirSync(outside);

    seedDemoBoard(root);

    expect(readdirSync(outside)).toEqual(before);
    expect(existsSync(join(outside, ".vibeflow", "demo-seed.json"))).toBe(false);
    expect(existsSync(join(root, ".vibeflow", "demo-seed.json"))).toBe(true);
  });
});

describe("first-run auto-seed for a local project (ticket e5176b6c)", () => {
  it("seeds an empty project once and reports the card count", () => {
    const root = freshRoot();
    const result = maybeSeedEmptyProject(root);

    expect(result.seeded).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(10);
    expect(countStoredTasks(root)).toBe(result.count);
    expect(existsSync(join(root, ".vibeflow", "demo-seed.json"))).toBe(true);
  });

  it("never reseeds — the marker decides, not emptiness", () => {
    const root = freshRoot();
    const first = maybeSeedEmptyProject(root);
    const second = maybeSeedEmptyProject(root);

    expect(first.seeded).toBe(true);
    expect(second.seeded).toBe(false);
    expect(second.reason).toBe("marker");
    expect(countStoredTasks(root)).toBe(first.count);
  });

  it("stays empty after the user deletes every sample (no resurrection)", () => {
    const root = freshRoot();
    maybeSeedEmptyProject(root);

    // Simulate the user deleting every task, marker left behind.
    rmSync(join(root, ".vibeflow", "tasks"), { recursive: true, force: true });

    const again = maybeSeedEmptyProject(root);
    expect(again.seeded).toBe(false);
    expect(again.reason).toBe("marker");
    expect(countStoredTasks(root)).toBe(0);
  });

  it("never touches a project that already has tasks", async () => {
    const root = freshRoot();
    const { createTask } = await import("../../src/core/tasks.js");
    createTask(root, { title: "real work", description: "", status: "todo", selector: "/" } as never);

    const result = maybeSeedEmptyProject(root);
    expect(result.seeded).toBe(false);
    expect(result.reason).toBe("not-empty");
    expect(countStoredTasks(root)).toBe(1);
    const titles = readTasks(root).map((t) => t.title);
    expect(titles).toEqual(["real work"]);
  });
});
