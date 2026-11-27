/**
 * Short-TTL claim LEASE with a fencing token (ticket dh4jdeta).
 *
 * The status write alone is an optimistic claim: the loser learns who won only
 * by reading the status afterwards, and two idle agents that both START before
 * either writes cannot tell that they are racing at all. The lease makes that
 * window explicit: `{ holder, token, expiresAt }` is written in the SAME
 * critical section as the claim, renewed while the agent works, and re-admitted
 * when it expires.
 *
 * ## The fencing token is ENFORCED, never logged
 *
 * `token` is monotonic per task. A write or renewal that CARRIES a token older
 * than the current holder's is REFUSED (`LEASE_STALE`) — accepting it with a
 * warning would look like mutual exclusion while providing none. This is what
 * stops a partitioned holder from re-claiming after its lease expired and a
 * peer legitimately took over: expiry re-admits the PEER (with a higher token),
 * it never re-admits the stale holder.
 *
 * ## Timing (relative to the follower's 30 s heartbeat)
 *
 * `SUBSCRIBER_HEARTBEAT_MS = 30_000` is the cadence at which a following agent
 * reports liveness. The lease is therefore:
 *   - TTL = 3 × heartbeat = 90 s — tolerates two missed beats before a peer may
 *     take over, so an ordinary slow write never loses its task;
 *   - renewal cadence = 1 × heartbeat = 30 s — each renewal pushes the expiry
 *     three beats out, so a live agent's lease never gets close to expiry.
 * A killed agent holds nothing longer than the TTL: expiry is the only release
 * path and it needs no graceful shutdown.
 *
 * ## Sidecar, not the task record
 *
 * The lease lives in `.vibeflow/leases/<taskId>.json`, NOT on the task record,
 * because the record schema is `z.strict()`: an unknown root key
 * QUARANTINES the task (excluded from listing/merge/push) — a lease on the
 * record would take the task off the board. The sidecar also keeps lease churn
 * out of the pushed record: lease state is per-machine, never shared.
 *
 * It is deliberately NOT under `.vibeflow/tasks/`: `findTaskFilePath` treats
 * any `<tasks>/<subdir>/<id>.json` as the task record, so a sidecar sharing the
 * task's filename would shadow the record it protects. `.vibeflow/leases/`
 * sits beside `tasks/`, and `.locks/` stays where it is (its files end in
 * `.lock`, never `.json`, so they cannot shadow).
 *
 * **Atomicity and kill-safety:** the caller holds the task/claim lock for the
 * whole read-modify-write, so the lease and the record it describes are written
 * in ONE critical section; each file is replaced by tmp+rename, so a kill can
 * never leave a torn lease. A kill BETWEEN the two writes leaves a live lease
 * over a still-todo task — the next claimant waits at most one TTL, which is
 * exactly what a lease TTL is for (the safe direction; the reverse order would
 * leave a claimed task unfenced).
 *
 * ## Wire parity (with the hosted surface)
 *
 * Same refusal codes on both surfaces — `LEASE_HELD` (a live foreign lease) and
 * `LEASE_STALE` (a token older than the current holder's) — and the same loser
 * payload `{ holder, token, expiresAt }`: who holds it and when it ends.
 * Full envelope parity is ticket 0045949e; this module only fixes the codes and
 * the payload fields so the two surfaces cannot drift.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTO_DIR } from "./types.js";

/**
 * Lease lifetime: 3 × the follower's 30 s heartbeat. Two beats may be missed
 * before a peer is allowed to take the task over.
 */
export const LEASE_TTL_MS = 90_000;

/**
 * Renewal cadence: one heartbeat (30 s). Renewing at TTL/3 means a live agent
 * is always two beats away from expiry, so a single stalled tick cannot lose it.
 */
export const LEASE_RENEW_MS = 30_000;

/** One task's lease, as persisted and as reported to a loser. */
export interface TaskLease {
  /** Who holds it: the agent session id (`pi-<pid>`) or the git/OS user name. */
  holder: string;
  /**
   * Monotonic fencing token. Minted as `max(previous + 1, nowMs)` so it
   * survives a lost/corrupt sidecar (a fresh mint is always larger than any
   * token a peer could still be carrying) and never repeats.
   */
  token: number;
  /** ISO-8601 UTC. `expiresAt <= now` means the lease is re-admittable. */
  expiresAt: string;
}

/** The only two refusals; identical strings on the hosted surface. */
export type LeaseRefusalCode = "LEASE_HELD" | "LEASE_STALE";

/**
 * What the LOSER is told: the code plus the current holder's identity and when
 * its lease ends — never just "busy".
 */
export interface LeaseRefusal {
  code: LeaseRefusalCode;
  holder: string;
  token: number;
  expiresAt: string;
}

/** Thrown so a caller can refuse the whole write, not merely warn. */
export class TaskLeaseRefusedError extends Error {
  readonly refusal: LeaseRefusal;
  constructor(refusal: LeaseRefusal) {
    super(
      `${refusal.code}: task is leased by ${refusal.holder} until ${refusal.expiresAt}`,
    );
    this.name = "TaskLeaseRefusedError";
    this.refusal = refusal;
  }
}

/** Sidecar path for one task. The directory is created on first write. */
export function taskLeasePath(projectDir: string, taskId: string): string {
  return join(projectDir, PROTO_DIR, "leases", `${taskId}.json`);
}

function isTaskLease(value: unknown): value is TaskLease {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.holder === "string" &&
    v.holder.length > 0 &&
    typeof v.token === "number" &&
    Number.isFinite(v.token) &&
    v.token > 0 &&
    typeof v.expiresAt === "string" &&
    Number.isFinite(Date.parse(v.expiresAt))
  );
}

/**
 * The stored lease, or null when there is none.
 *
 * An unreadable/malformed sidecar is treated as ABSENT: it names no holder and
 * cannot fence anyone, so it must not wedge the task forever. Re-admission then
 * mints `max(nowMs, …)` — a token larger than any value the corrupt file could
 * have carried, so a stale holder is still refused by the comparison.
 */
export function readTaskLease(
  projectDir: string,
  taskId: string,
): TaskLease | null {
  try {
    const raw = JSON.parse(
      readFileSync(taskLeasePath(projectDir, taskId), "utf-8"),
    ) as unknown;
    return isTaskLease(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** True while `now` has not reached `expiresAt`. */
export function isLeaseLive(lease: TaskLease, now: number = Date.now()): boolean {
  return Date.parse(lease.expiresAt) > now;
}

/** tmp+rename so a kill can never expose a half-written lease. */
function writeTaskLease(
  projectDir: string,
  taskId: string,
  lease: TaskLease,
): TaskLease {
  const dir = join(projectDir, PROTO_DIR, "leases");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${taskId}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease, null, 2), "utf-8");
  renameSync(tmp, path);
  return lease;
}

/** Next fencing token: strictly greater than the previous holder's. */
function mintToken(previous: TaskLease | null, now: number): number {
  return Math.max((previous?.token ?? 0) + 1, now);
}

export interface LeaseClock {
  /** Injected for tests; production uses the wall clock. */
  now?: number;
}

/**
 * Take (or renew) the lease for `taskId`.
 *
 * - live lease held by a DIFFERENT holder → `LEASE_HELD` (the loser is told the
 *   holder and when the lease ends);
 * - live lease held by the SAME holder → renewed in place (same token);
 * - absent or EXPIRED → re-admitted with a NEW, higher token. Expiry re-admits
 *   the task, and the new token is what locks the old holder out for good.
 *
 * Throws `TaskLeaseRefusedError` — the caller must abort its write.
 */
export function acquireTaskLease(
  projectDir: string,
  taskId: string,
  holder: string,
  clock: LeaseClock = {},
): TaskLease {
  const now = clock.now ?? Date.now();
  const current = readTaskLease(projectDir, taskId);
  if (current && isLeaseLive(current, now)) {
    if (current.holder !== holder) {
      throw new TaskLeaseRefusedError({
        code: "LEASE_HELD",
        holder: current.holder,
        token: current.token,
        expiresAt: current.expiresAt,
      });
    }
    return writeTaskLease(projectDir, taskId, {
      ...current,
      expiresAt: new Date(now + LEASE_TTL_MS).toISOString(),
    });
  }
  return writeTaskLease(projectDir, taskId, {
    holder,
    token: mintToken(current, now),
    expiresAt: new Date(now + LEASE_TTL_MS).toISOString(),
  });
}

/**
 * Extend a lease ALREADY held under `token`.
 *
 * THE FENCE: `token` must equal the stored token. An older token is refused
 * (`LEASE_STALE`) even when the caller's own lease merely expired and a peer
 * took over meanwhile — that is the partition case this ticket exists for. The
 * holder string is reported, not trusted: the token, not the name, decides.
 *
 * A renewal never mints: re-admission is `acquireTaskLease`, so a caller cannot
 * bump its own token by asking to renew.
 */
export function renewTaskLease(
  projectDir: string,
  taskId: string,
  token: number,
  clock: LeaseClock = {},
): TaskLease {
  const now = clock.now ?? Date.now();
  const current = readTaskLease(projectDir, taskId);
  if (!current || token !== current.token || !isLeaseLive(current, now)) {
    throw new TaskLeaseRefusedError({
      code: "LEASE_STALE",
      holder: current?.holder ?? "none",
      token: current?.token ?? 0,
      expiresAt: current?.expiresAt ?? new Date(0).toISOString(),
    });
  }
  return writeTaskLease(projectDir, taskId, {
    ...current,
    expiresAt: new Date(now + LEASE_TTL_MS).toISOString(),
  });
}

/**
 * Drop the lease, but ONLY for the current token. A stale holder that woke up
 * after a takeover cannot release the new holder's lease. Returns whether a
 * release happened.
 */
export function releaseTaskLease(
  projectDir: string,
  taskId: string,
  token: number,
): boolean {
  const current = readTaskLease(projectDir, taskId);
  if (!current || current.token !== token) return false;
  try {
    const path = taskLeasePath(projectDir, taskId);
    if (existsSync(path)) unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
