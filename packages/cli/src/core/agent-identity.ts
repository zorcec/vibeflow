/**
 * Who is this agent? (ticket b7dvqr7z)
 *
 * The echo filter (`kzxaq0fd`) shipped needing the operator to export
 * `$VIBEFLOW_ACTOR`. With it unset — the default — every write an agent makes
 * is stamped `actor: agent` with no identity, so nothing matches and the agent
 * is handed back its own operations. That is the wrong default: an echo filter
 * that only works when configured is not a filter.
 *
 * The harness exports no session id (only `PI_CONFIG_DIR` / `PI_CODING_AGENT`,
 * and its children INHERIT those, so they identify "somewhere under pi", not
 * which session), and an already-running shell cannot be given a variable
 * retroactively. So the identity is DERIVED from something both sides already
 * share: **the ancestor pi session process**.
 *
 *   - a CLI write and its follower are both descendants of the SAME pi pid;
 *   - a peer agent is a descendant of a different one;
 *   - a user's own terminal has no pi ancestor at all;
 *   - a board/API write carries no agent.
 *
 * Hence `pi-<pid>` separates exactly the two cases the owner named: my own
 * operations never come back, every other agent's and every user's always do.
 *
 * Precedence, and why: `$VIBEFLOW_ACTOR` wins (an operator naming their agent
 * explicitly is intent we must not override); then the derived `pi-<pid>`;
 * then NO identity, which suppresses nothing — silence must never come from an
 * unknown identity, so a wrong guess degrades to noise, never to blindness.
 */
import { readFileSync } from "node:fs";

/** Where an identity came from — logged so a wrong id is diagnosable. */
export type AgentIdentitySource = "env" | "pi-session" | "none";

export interface AgentIdentity {
  /** Stamped on writes and matched by the follower. Absent = no suppression. */
  id?: string;
  source: AgentIdentitySource;
}

/**
 * The slice of the process tree the resolver needs. Injected so the logic is
 * unit-testable without a live pi (and so a platform without `/proc` can
 * supply its own reader).
 */
export interface ProcessTree {
  /** Parent pid, or null when unknown. */
  ppid(pid: number): number | null;
  /** Full command line, or null when unreadable. */
  cmdline(pid: number): string | null;
}

/**
 * Is this process the pi harness ITSELF?
 *
 * Matching the cmdline (not the environment) is what makes this work: the
 * harness's children inherit `PI_CODING_AGENT`, so an environment probe would
 * stop at the intermediate shell and hand the writer and its follower
 * DIFFERENT ids.
 *
 * It must be strict about WHERE the name appears. The first, too-loose version
 * matched any cmdline containing a `/pi` token — and a shell running a script
 * that merely MENTIONS `pi` in an argument (`/tmp/fakebin/pi …`, a grep, a
 * ticket id in a comment) became a "session". Observed live: two different
 * ids derived inside one session, so the writer's id never matched its
 * follower's and the filter silently did nothing. Hence: the EXECUTABLE (first
 * token) must be pi, or node running the harness entry point.
 */
function isPiSessionProcess(cmdline: string): boolean {
  const parts = cmdline.trim().split(/\s+/);
  const first = parts[0] ?? "";
  const base = (first.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (base === "pi" || base === "pi.js") return true;
  if (base === "node" || base === "node.exe") {
    return parts
      .slice(1, 3)
      .some((arg) => arg.toLowerCase().includes("pi-coding-agent"));
  }
  return false;
}

/** Bound on the ancestor walk: sessions are shallow; cycles must not hang. */
const MAX_ANCESTOR_HOPS = 16;

/** Linux `/proc` reader. Any other platform simply has no identity. */
export const procfsTree: ProcessTree = {
  ppid(pid: number): number | null {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // `pid (comm) state ppid …` — comm may contain spaces/parens, so parse
      // after the LAST ")": fields resume with state, then ppid.
      const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const ppid = Number(after[1]);
      return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
    } catch {
      return null;
    }
  },
  cmdline(pid: number): string | null {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {
      return null;
    }
  },
};

/** Read this process's parent pid without `/proc` (portable). */
function selfParent(pid: number): number | null {
  try {
    // `readlink /proc/self` is Linux-only; `process.ppid` is universal.
    return pid === process.pid ? (process.ppid ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Memo for the PROCESS WALK ONLY.
 *
 * The walk touches `/proc` per ancestor, and it is called on every confirmed
 * write and every delivered event; the answer cannot change while the process
 * lives (a pid cannot become a different session). The ENV is deliberately
 * NOT memoised: caching the whole answer meant a caller that changed
 * `$VIBEFLOW_ACTOR` in the same process got the stale verdict — which is
 * exactly what the CLI test suite (and any long-lived harness) does.
 */
let cachedDerived: { id?: string } | null = null;

export function resolveAgentIdentity(
  env: NodeJS.ProcessEnv = process.env,
  tree: ProcessTree = procfsTree,
  opts: { selfPid?: number; refresh?: boolean } = {},
): AgentIdentity {
  const explicit = env["VIBEFLOW_ACTOR"]?.trim();
  if (explicit !== undefined && explicit !== "") {
    return { id: explicit, source: "env" };
  }
  // The suite's switch is read from the REAL process env as well as the caller's
  // copy: tests pass a literal env object (`{}`) to pin "nothing configured",
  // and the derivation after it walks the real process tree — without this the
  // same assertion would pass in CI and fail under pi (ticket b7dvqr7z).
  if (
    env["VIBEFLOW_AGENT_IDENTITY"]?.trim() === "off" ||
    process.env["VIBEFLOW_AGENT_IDENTITY"]?.trim() === "off"
  ) {
    return { source: "none" };
  }
  if (cachedDerived !== null && opts.refresh !== true) {
    return cachedDerived.id !== undefined
      ? { id: cachedDerived.id, source: "pi-session" }
      : { source: "none" };
  }
  const derived = deriveFromProcessTree(tree, opts.selfPid ?? process.pid);
  cachedDerived = { ...(derived !== undefined ? { id: derived } : {}) };
  return derived !== undefined
    ? { id: derived, source: "pi-session" }
    : { source: "none" };
}

/** Test seam: forget the memo (a suite that reuses the process). */
export function __resetAgentIdentityForTests(): void {
  cachedDerived = null;
}

/** Walk ancestors for the pi session process. Pure; no env involved. */
function deriveFromProcessTree(
  tree: ProcessTree,
  selfPid: number,
): string | undefined {
  let pid = selfParent(selfPid) ?? tree.ppid(selfPid);
  const seen = new Set<number>();
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    if (pid === null || pid <= 1) break;
    if (seen.has(pid)) break; // a cycle is a broken tree, not an identity
    seen.add(pid);
    const cmdline = tree.cmdline(pid);
    if (cmdline !== null && isPiSessionProcess(cmdline)) {
      return `pi-${pid}`;
    }
    pid = tree.ppid(pid);
  }
  return undefined;
}

/**
 * Human-readable origin, for the one line a follower prints when it starts
 * under `--verbose`. Never used for decisions.
 */
export function describeAgentIdentity(identity: AgentIdentity): string {
  if (identity.id === undefined) {
    return "no agent identity (own writes will be delivered — export VIBEFLOW_ACTOR to suppress them)";
  }
  return identity.source === "env"
    ? `agent ${identity.id} (VIBEFLOW_ACTOR)`
    : `agent ${identity.id} (derived from the pi session)`;
}
