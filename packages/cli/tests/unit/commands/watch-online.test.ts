import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../../src/auth/mode.js", () => ({
  getMode: vi.fn(),
}));

vi.mock("../../../src/saas/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/saas/client.js")>()),
  fetchSaasTasks: vi.fn(),
}));

import { getMode } from "../../../src/auth/mode.js";
import { fetchSaasTasks } from "../../../src/saas/client.js";
import {
  watch,
  buildOnlineSnapshots,
  diffOnlineSnapshots,
  runOnlinePoll,
  resolveOnlinePollMs,
  computeOnlineRetryDelayMs,
  isOnlineAuthFailure,
  renderOnlineTicket,
  printTaskAnnouncement,
  DEFAULT_ONLINE_POLL_MS,
  MIN_ONLINE_POLL_MS,
  MAX_ONLINE_POLL_BACKOFF_MS,
  WATCH_INTERVAL_ENV_VAR,
} from "../../../src/commands/watch.js";

const NOW = "2026-10-17T00:00:00.000Z";

function saasTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Test Task",
    description: "do the thing",
    status: "todo",
    priority: "p1",
    type: "Task",
    boardId: "board-1",
    createdAt: NOW,
    updatedAt: NOW,
    commentCount: 0,
    fileCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getMode).mockResolvedValue("local");
  delete process.env[WATCH_INTERVAL_ENV_VAR];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env[WATCH_INTERVAL_ENV_VAR];
});

describe("resolveOnlinePollMs", () => {
  it("defaults to 15s", () => {
    expect(resolveOnlinePollMs()).toBe(DEFAULT_ONLINE_POLL_MS);
    expect(DEFAULT_ONLINE_POLL_MS).toBe(15_000);
  });

  it("prefers the explicit flag over the env var", () => {
    process.env[WATCH_INTERVAL_ENV_VAR] = "30000";
    expect(resolveOnlinePollMs(20_000)).toBe(20_000);
  });

  it("reads the env var when no flag is given", () => {
    process.env[WATCH_INTERVAL_ENV_VAR] = "30000";
    expect(resolveOnlinePollMs()).toBe(30_000);
  });

  it("floors at 5s so neither flag nor env can hammer the box", () => {
    expect(resolveOnlinePollMs(1000)).toBe(MIN_ONLINE_POLL_MS);
    process.env[WATCH_INTERVAL_ENV_VAR] = "100";
    expect(resolveOnlinePollMs()).toBe(MIN_ONLINE_POLL_MS);
  });

  it("ignores a garbage env var", () => {
    process.env[WATCH_INTERVAL_ENV_VAR] = "not-a-number";
    expect(resolveOnlinePollMs()).toBe(DEFAULT_ONLINE_POLL_MS);
  });
});

describe("computeOnlineRetryDelayMs", () => {
  it("doubles per consecutive failure and caps at 120s", () => {
    expect(computeOnlineRetryDelayMs(15_000, 0)).toBe(15_000);
    expect(computeOnlineRetryDelayMs(15_000, 1)).toBe(30_000);
    expect(computeOnlineRetryDelayMs(15_000, 2)).toBe(60_000);
    expect(computeOnlineRetryDelayMs(15_000, 10)).toBe(
      MAX_ONLINE_POLL_BACKOFF_MS,
    );
    expect(MAX_ONLINE_POLL_BACKOFF_MS).toBe(120_000);
  });
});

describe("isOnlineAuthFailure", () => {
  it("treats a missing token as auth failure", () => {
    expect(isOnlineAuthFailure({ code: "NOT_AUTHENTICATED" })).toBe(true);
  });

  it("treats HTTP 401/403 as auth failure (expired/revoked/wrong-scope)", () => {
    expect(isOnlineAuthFailure({ code: "HTTP_ERROR", status: 401 })).toBe(true);
    expect(isOnlineAuthFailure({ code: "HTTP_ERROR", status: 403 })).toBe(true);
  });

  it("treats server and network errors as retryable, not auth", () => {
    expect(isOnlineAuthFailure({ code: "HTTP_ERROR", status: 500 })).toBe(
      false,
    );
    expect(isOnlineAuthFailure({ code: "NETWORK_ERROR" })).toBe(false);
  });
});

describe("buildOnlineSnapshots", () => {
  it("maps SaaS statuses and counts into the shared snapshot shape", () => {
    const snaps = buildOnlineSnapshots(
      [saasTask({ id: "a", status: "in_progress", commentCount: 2, fileCount: 1 })],
      NOW,
    );
    const snap = snaps.get("a");
    expect(snap).toMatchObject({
      taskId: "a",
      status: "in-progress",
      commentCount: 2,
      fileCount: 1,
      takenAt: NOW,
    });
  });

  it("falls back to hydrated array lengths when counts are absent", () => {
    const task = saasTask({ id: "b" });
    delete (task as Record<string, unknown>).commentCount;
    delete (task as Record<string, unknown>).fileCount;
    (task as Record<string, unknown>).comments = [
      { id: "c1", taskId: "b", body: "hi", authorId: "", createdAt: NOW },
    ];
    (task as Record<string, unknown>).files = [{ name: "a.md" }];
    const snaps = buildOnlineSnapshots([task], NOW);
    expect(snaps.get("b")).toMatchObject({
      commentCount: 1,
      fileCount: 1,
      lastCommentAt: NOW,
    });
  });
});

describe("diffOnlineSnapshots", () => {
  it("detects new tasks, moved-to-todo, and comment bumps in the shared dialect", () => {
    const prev = buildOnlineSnapshots(
      [saasTask({ id: "keep", status: "todo", commentCount: 0 })],
      NOW,
    );
    const current = buildOnlineSnapshots(
      [
        saasTask({ id: "keep", status: "todo", commentCount: 1 }),
        saasTask({ id: "fresh", status: "backlog" }),
        saasTask({ id: "ready", status: "todo" }),
      ],
      NOW,
    );
    // "ready" has no prev snapshot at all in this map setup — add one that
    // shows it transitioning from another status.
    const prevWithReady = new Map(prev);
    prevWithReady.set(
      "ready",
      buildOnlineSnapshots([saasTask({ id: "ready", status: "backlog" })], NOW).get(
        "ready",
      )!,
    );
    const events = diffOnlineSnapshots(current, prevWithReady);
    const typesFor = (id: string) => events.filter((e) => e.taskId === id).map((e) => e.type);
    expect(typesFor("fresh")).toEqual(["new"]);
    expect(typesFor("ready")).toContain("moved-to-todo");
    expect(typesFor("keep")).toContain("comment");
  });

  it("emits nothing when nothing changed", () => {
    const tasks = [saasTask({ id: "a" })];
    expect(
      diffOnlineSnapshots(
        buildOnlineSnapshots(tasks, NOW),
        buildOnlineSnapshots(tasks, NOW),
      ),
    ).toEqual([]);
  });
});

describe("runOnlinePoll", () => {
  it("returns snapshots and new-task events on success", async () => {
    const outcome = await runOnlinePoll(
      () =>
        Promise.resolve({
          ok: true as const,
          data: { tasks: [saasTask()], boardId: "b" },
        }),
      new Map(),
      NOW,
    );
    expect(outcome.failure).toBeUndefined();
    expect(outcome.snapshots.size).toBe(1);
    expect(outcome.tasks).toHaveLength(1);
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]).toMatchObject({ type: "new", taskId: "task-1" });
  });

  it("flags auth failures loudly (never a silent empty watch)", async () => {
    const outcome = await runOnlinePoll(
      () =>
        Promise.resolve({
          ok: false as const,
          error: { code: "HTTP_ERROR", message: "unauthorized", status: 401 },
        }),
      new Map(),
      NOW,
    );
    expect(outcome.failure).toBe("auth");
    expect(outcome.events).toEqual([]);
  });

  it("flags network/server failures as retryable errors", async () => {
    const outcome = await runOnlinePoll(
      () =>
        Promise.resolve({
          ok: false as const,
          error: { code: "NETWORK_ERROR", message: "boom" },
        }),
      new Map(),
      NOW,
    );
    expect(outcome.failure).toBe("error");
    expect(outcome.message).toBe("boom");
  });

  it("flags a thrown fetch as a retryable error", async () => {
    const outcome = await runOnlinePoll(
      () => Promise.reject(new Error("socket hang up")),
      new Map(),
      NOW,
    );
    expect(outcome.failure).toBe("error");
    expect(outcome.message).toBe("socket hang up");
  });
});

describe("shared formatter", () => {
  it("prints the same banner frame for new and moved-to-todo", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    printTaskAnnouncement("new", "Task: x");
    printTaskAnnouncement("moved-to-todo", "Task: y");
    const joined = lines.join("\n");
    expect(joined).toContain("🆕 NEW TASK");
    expect(joined).toContain("▶ MOVED TO TODO");
    // Same 62-char divider above and below in both banners (4 total).
    expect(lines.filter((l) => l.includes("─".repeat(62))).length).toBe(4);
  });

  it("renders an online ticket summary with the fields the banner needs", () => {
    const text = renderOnlineTicket(saasTask({ id: "t-9", status: "todo" }));
    expect(text).toContain("Task: t-9");
    expect(text).toContain("Status: todo");
    expect(text).toContain("Comments: 0  Files: 0");
  });
});

describe("online mode is no longer a silent no-op", () => {
  it("routes watch --once through the SaaS fetch when logged in", async () => {
    vi.mocked(getMode).mockResolvedValue("saas");
    vi.mocked(fetchSaasTasks).mockResolvedValue({
      ok: true,
      data: { tasks: [saasTask({ id: "online-1" })], boardId: "b" },
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const dir = mkdtempSync(join(tmpdir(), "watch-online-"));
    const outFile = join(dir, "events.jsonl");

    await watch(dir, { once: true, output: outFile });

    expect(fetchSaasTasks).toHaveBeenCalledTimes(1);
    expect(fetchSaasTasks).toHaveBeenCalledWith(undefined, {
      hydrate: false,
    });
    // First --once seeds state; the seeded new-task event is emitted.
    const written = readFileSync(outFile, "utf8");
    expect(written).toContain("online-1");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("fails loudly (non-zero, no fetch loop) on an expired/revoked PAT", async () => {
    vi.mocked(getMode).mockResolvedValue("saas");
    vi.mocked(fetchSaasTasks).mockResolvedValue({
      ok: false,
      error: { code: "HTTP_ERROR", message: "unauthorized", status: 401 },
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const dir = mkdtempSync(join(tmpdir(), "watch-online-auth-"));

    await watch(dir, { once: true, json: true });

    expect(fetchSaasTasks).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(4);
    expect(errors.join("\n")).toMatch(/authentication failed/i);
    expect(exit).not.toHaveBeenCalled();
    process.exitCode = 0;
  });
});
