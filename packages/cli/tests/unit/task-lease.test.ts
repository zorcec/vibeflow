/**
 * Claim LEASE with a fencing token (ticket dh4jdeta) — the failure modes, not
 * the happy path. A token that is recorded but not compared looks like mutual
 * exclusion and is not; every test below pins a REFUSAL.
 *
 * Failure modes required by the ticket, per backend:
 *   - a live foreign lease is refused;
 *   - an expired lease re-admits (with a NEW, higher token);
 *   - a stale token cannot steal;
 *   - a renewal with an old token is refused;
 *   - the loser sees the holder (identity + when the lease ends).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  TaskLeaseRefusedError,
  acquireTaskLease,
  isLeaseLive,
  readTaskLease,
  releaseTaskLease,
  renewTaskLease,
  taskLeasePath,
} from "../../src/core/task-lease.js";
import {
  claimNextTaskAtomic,
  updateTask,
} from "../../src/core/tasks.js";
import type { LeaseRefusal } from "../../src/core/task-lease.js";

const PROTO = ".vibeflow";

function writeTask(projectDir: string, task: Record<string, unknown>) {
  const dir = join(projectDir, PROTO, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${task.id as string}.json`),
    JSON.stringify(task, null, 2) + "\n",
  );
}

function taskPath(projectDir: string, id: string): string {
  return join(projectDir, PROTO, "tasks", `${id}.json`);
}

function todoTask(id = "task-1") {
  return {
    id,
    status: "todo",
    title: "Claim me",
    created: "2026-01-01T00:00:00.000Z",
  };
}

describe("claim lease (local file store)", () => {
  let dir: string;
  const T0 = Date.parse("2026-11-27T12:00:00.000Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-test-"));
    writeTask(dir, todoTask());
  });

  it("writes the lease in the same claim as the status, TTL = 3 heartbeats", () => {
    const claimed = claimNextTaskAtomic(dir, {
      holder: "agent-a",
      leaseClock: { now: T0 },
    });
    expect(claimed?.status).toBe("in-progress");

    const lease = readTaskLease(dir, "task-1");
    expect(lease).not.toBeNull();
    expect(lease!.holder).toBe("agent-a");
    expect(lease!.token).toBeGreaterThan(0);
    expect(Date.parse(lease!.expiresAt) - T0).toBe(LEASE_TTL_MS);
    // Exactly three 30 s follower heartbeats — the TTL is anchored, not tuned.
    expect(LEASE_TTL_MS).toBe(3 * LEASE_RENEW_MS);
    expect(LEASE_RENEW_MS).toBe(30_000);
  });

  it("REFUSES a live foreign lease and reports holder + expiry to the loser", () => {
    acquireTaskLease(dir, "task-1", "agent-a", { now: T0 });

    // The record is still todo (as if B selected the task before A wrote):
    // the lease, not the status, is what must stop B.
    let refusal: LeaseRefusal | undefined;
    const claimed = claimNextTaskAtomic(dir, {
      holder: "agent-b",
      leaseClock: { now: T0 + 1 },
      onLeaseRefused: (r) => {
        refusal = r;
      },
    });

    expect(claimed).toBeNull();
    expect(refusal).toBeDefined();
    expect(refusal!.code).toBe("LEASE_HELD");
    // The loser SEES the holder and when the lease ends.
    expect(refusal!.holder).toBe("agent-a");
    expect(refusal!.token).toBe(readTaskLease(dir, "task-1")!.token);
    expect(Date.parse(refusal!.expiresAt)).toBe(T0 + LEASE_TTL_MS);
    // Nothing was written by the loser: the task is still claimable.
    const stillTodo = JSON.parse(readFileSync(taskPath(dir, "task-1"), "utf-8"));
    expect(stillTodo.status).toBe("todo");
  });

  it("re-admits an EXPIRED lease with a new, higher fencing token", () => {
    const first = acquireTaskLease(dir, "task-1", "agent-a", { now: T0 });
    expect(isLeaseLive(first, T0 + LEASE_TTL_MS - 1)).toBe(true);
    expect(isLeaseLive(first, T0 + LEASE_TTL_MS)).toBe(false);

    const second = acquireTaskLease(dir, "task-1", "agent-b", {
      now: T0 + LEASE_TTL_MS,
    });
    expect(second.holder).toBe("agent-b");
    expect(second.token).toBeGreaterThan(first.token);
  });

  it("a STALE token cannot steal the task after a takeover", () => {
    const stale = acquireTaskLease(dir, "task-1", "agent-a", { now: T0 });
    // A's lease expires; B legitimately takes over.
    const takeover = acquireTaskLease(dir, "task-1", "agent-b", {
      now: T0 + LEASE_TTL_MS + 1,
    });
    expect(takeover.token).toBeGreaterThan(stale.token);

    // A wakes up after the partition and tries to write carrying its old
    // token: REFUSED. Expiry re-admitted B; it must not also re-admit A.
    expect(() =>
      renewTaskLease(dir, "task-1", stale.token, {
        now: T0 + LEASE_TTL_MS + 2,
      }),
    ).toThrow(TaskLeaseRefusedError);
    const err = (() => {
      try {
        renewTaskLease(dir, "task-1", stale.token, {
          now: T0 + LEASE_TTL_MS + 2,
        });
      } catch (e) {
        return e as TaskLeaseRefusedError;
      }
      return null;
    })();
    expect(err!.refusal.code).toBe("LEASE_STALE");
    expect(err!.refusal.holder).toBe("agent-b");
    expect(err!.refusal.token).toBe(takeover.token);

    // And the task record is untouched by the refused write.
    expect(readTaskLease(dir, "task-1")!.holder).toBe("agent-b");

    // The stale holder's WRITE is refused too, not just its renewal.
    const before = readFileSync(taskPath(dir, "task-1"), "utf-8");
    expect(() =>
      updateTask(
        dir,
        "task-1",
        { status: "in-progress" },
        { lease: { mode: "renew", holder: "agent-a", token: stale.token } },
      ),
    ).toThrow(TaskLeaseRefusedError);
    expect(readFileSync(taskPath(dir, "task-1"), "utf-8")).toBe(before);
  });

  it("REFUSES a renewal carrying an older token (same holder name, older token)", () => {
    const live = acquireTaskLease(dir, "task-1", "agent-a", { now: T0 });
    // A second holder took over the same NAME later (a restarted agent).
    acquireTaskLease(dir, "task-1", "agent-a", {
      now: T0 + LEASE_TTL_MS + 1,
    });

    expect(() =>
      renewTaskLease(dir, "task-1", live.token, {
        now: T0 + LEASE_TTL_MS + 2,
      }),
    ).toThrow(/LEASE_STALE/);
  });

  it("renews a live lease in place, extending the expiry and keeping the token", () => {
    const live = acquireTaskLease(dir, "task-1", "agent-a", { now: T0 });
    const renewed = renewTaskLease(dir, "task-1", live.token, {
      now: T0 + LEASE_RENEW_MS,
    });
    expect(renewed.token).toBe(live.token);
    expect(Date.parse(renewed.expiresAt)).toBe(T0 + LEASE_RENEW_MS + LEASE_TTL_MS);
  });

  it("re-admits when the sidecar is unreadable, with a token above any stored one", () => {
    acquireTaskLease(dir, "task-1", "agent-a", { now: T0 });
    // A torn/legacy sidecar names no holder and cannot fence.
    writeFileSync(taskLeasePath(dir, "task-1"), "{not json", "utf-8");
    const readmitted = acquireTaskLease(dir, "task-1", "agent-b", { now: T0 + 1 });
    expect(readmitted.holder).toBe("agent-b");
    // Token is time-derived, so it is still above anything A could carry.
    expect(readmitted.token).toBeGreaterThanOrEqual(T0 + 1);
  });

  it("only the current token may release the lease", () => {
    const live = acquireTaskLease(dir, "task-1", "agent-a", { now: T0 });
    expect(releaseTaskLease(dir, "task-1", live.token - 1)).toBe(false);
    expect(releaseTaskLease(dir, "task-1", live.token)).toBe(true);
    expect(readTaskLease(dir, "task-1")).toBeNull();
  });

  it("a same-holder claim renews instead of refusing (an agent continuing its own work)", () => {
    acquireTaskLease(dir, "task-1", "agent-a", { now: T0 });
    const again = acquireTaskLease(dir, "task-1", "agent-a", { now: T0 + 1 });
    expect(again.holder).toBe("agent-a");
  });

  it("updateTask claims with the lease in the same locked write", () => {
    const updated = updateTask(
      dir,
      "task-1",
      { status: "in-progress" },
      { lease: { mode: "claim", holder: "agent-a" }, leaseClock: { now: T0 } },
    );
    expect(updated?.status).toBe("in-progress");
    expect(readTaskLease(dir, "task-1")!.holder).toBe("agent-a");
  });

  it("updateTask REFUSES a live foreign lease and writes nothing", () => {
    acquireTaskLease(dir, "task-1", "agent-a", { now: T0 });
    const before = readFileSync(taskPath(dir, "task-1"), "utf-8");
    expect(() =>
      updateTask(
        dir,
        "task-1",
        { status: "in-progress" },
        {
          lease: { mode: "claim", holder: "agent-b" },
          leaseClock: { now: T0 + 1 },
        },
      ),
    ).toThrow(TaskLeaseRefusedError);
    expect(readFileSync(taskPath(dir, "task-1"), "utf-8")).toBe(before);
    expect(readTaskLease(dir, "task-1")!.holder).toBe("agent-a");
  });
});
