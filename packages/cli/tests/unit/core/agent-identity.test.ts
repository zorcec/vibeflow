/**
 * Agent identity resolution (ticket b7dvqr7z).
 *
 * The echo filter used to need `$VIBEFLOW_ACTOR`; without it an agent was
 * handed back its own writes. The identity is now derived from the ancestor pi
 * session process, so these pin the two properties the owner asked for — own
 * writes never come back, every other agent's and every user's always do —
 * without needing a live pi: the process tree is injected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetAgentIdentityForTests,
  describeAgentIdentity,
  resolveAgentIdentity,
  type ProcessTree,
} from "../../../src/core/agent-identity.js";
import { notificationIdentity } from "../../../src/core/notifications.js";

/**
 * A fake tree. `pi` marks the session processes; every other entry is a plain
 * shell (which is what makes the CMDLINE the right discriminator — children
 * inherit PI_CODING_AGENT, so an env probe would stop at a shell).
 */
function tree(parents: Record<number, number>, cmds: Record<number, string>): ProcessTree {
  return {
    ppid: (pid) => parents[pid] ?? null,
    cmdline: (pid) => cmds[pid] ?? null,
  };
}

beforeEach(() => {
  __resetAgentIdentityForTests();
  // The global setup switches the derivation OFF so no other suite depends on
  // whether it runs under pi. These tests are the ones that exercise it, so the
  // switch is cleared here and the walk is driven by an injected tree.
  vi.stubEnv("VIBEFLOW_AGENT_IDENTITY", "");
  vi.stubEnv("VIBEFLOW_ACTOR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetAgentIdentityForTests();
});

describe("resolveAgentIdentity", () => {
  it("prefers an explicitly configured actor", () => {
    const identity = resolveAgentIdentity(
      { VIBEFLOW_ACTOR: "pi-a" },
      tree({}, {}),
    );
    expect(identity).toEqual({ id: "pi-a", source: "env" });
  });

  it("derives pi-<pid> from the nearest pi ancestor", () => {
    // 5000 (this process) → 4000 (bash) → 3000 (pi session) → 2000 (terminal)
    const t = tree(
      { 5000: 4000, 4000: 3000, 3000: 2000, 2000: 1 },
      {
        4000: "bash -lc node .../cli/index.js",
        3000: "node /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/main.js",
        2000: "zsh",
      },
    );
    const identity = resolveAgentIdentity({}, t, { selfPid: 5000 });
    expect(identity).toEqual({ id: "pi-3000", source: "pi-session" });
  });

  it("gives the WRITER and the FOLLOWER the same id, and a peer a different one", () => {
    // Same session: two different leaf pids, one pi ancestor.
    const writerTree = tree(
      { 9001: 8001, 8001: 7000, 7000: 1 },
      { 7000: "node .../pi-coding-agent/index.js" },
    );
    const followerTree = tree(
      { 9002: 8002, 8002: 7000, 7000: 1 },
      { 7000: "node .../pi-coding-agent/index.js" },
    );
    // A peer agent: same shape, different session pid.
    const peerTree = tree(
      { 9101: 8101, 8101: 7100, 7100: 1 },
      { 7100: "node .../pi-coding-agent/index.js" },
    );

    const writer = resolveAgentIdentity({}, writerTree, { selfPid: 9001, refresh: true });
    const follower = resolveAgentIdentity({}, followerTree, { selfPid: 9002, refresh: true });
    const peer = resolveAgentIdentity({}, peerTree, { selfPid: 9101, refresh: true });

    expect(writer.id).toBe("pi-7000");
    expect(follower.id).toBe(writer.id); // own write → same id → suppressed
    expect(peer.id).toBe("pi-7100");
    expect(peer.id).not.toBe(writer.id); // peer write → delivered
  });

  it("is not fooled by a shell that merely MENTIONS pi (the live bug)", () => {
    // This is the exact failure: a bash -c whose script text contains
    // `/tmp/fakebin/pi` was taken for a session, so the writer and its own
    // follower derived different ids and the filter did nothing.
    const t = tree(
      { 5000: 4000, 4000: 3000, 3000: 1 },
      {
        4000: "/bin/bash -c node .../cli/index.js tasks --edit x --comment /tmp/fakebin/pi",
        3000: "node .../pi-coding-agent/dist/main.js",
      },
    );
    expect(resolveAgentIdentity({}, t, { selfPid: 5000 })).toEqual({
      id: "pi-3000",
      source: "pi-session",
    });
  });

  it("has NO identity outside pi, so nothing is suppressed", () => {
    const t = tree(
      { 5000: 4000, 4000: 3000, 3000: 1 },
      { 4000: "bash", 3000: "systemd --user" },
    );
    expect(resolveAgentIdentity({}, t, { selfPid: 5000 })).toEqual({ source: "none" });
  });

  it("treats an unreadable tree as no identity instead of guessing", () => {
    const t: ProcessTree = { ppid: () => null, cmdline: () => null };
    expect(resolveAgentIdentity({}, t, { selfPid: 5000 })).toEqual({ source: "none" });
  });

  it("cannot hang on a cyclic tree", () => {
    const t = tree({ 5000: 4000, 4000: 5000 }, {});
    expect(resolveAgentIdentity({}, t, { selfPid: 5000 })).toEqual({ source: "none" });
  });

  it("honours the suite's off switch (a test must not depend on who runs it)", () => {
    const t = tree(
      { 5000: 4000, 4000: 3000, 3000: 1 },
      { 3000: "node .../pi-coding-agent/index.js" },
    );
    expect(
      resolveAgentIdentity({ VIBEFLOW_AGENT_IDENTITY: "off" }, t, { selfPid: 5000 }),
    ).toEqual({ source: "none" });
  });

  it("memoises, and can be reset", () => {
    const t = tree({ 5000: 4000, 4000: 1 }, { 4000: "node .../pi-coding-agent" });
    const first = resolveAgentIdentity({}, t, { selfPid: 5000 });
    // A different tree must not change the answer while the process lives.
    const second = resolveAgentIdentity({}, tree({}, {}), { selfPid: 5000 });
    expect(second).toEqual(first);
    __resetAgentIdentityForTests();
    expect(resolveAgentIdentity({}, tree({}, {}), { selfPid: 5000 })).toEqual({ source: "none" });
  });
});

describe("describeAgentIdentity", () => {
  it("says plainly when there is nothing to suppress with", () => {
    expect(describeAgentIdentity({ source: "none" })).toContain("VIBEFLOW_ACTOR");
    expect(describeAgentIdentity({ id: "pi-9", source: "env" })).toContain("VIBEFLOW_ACTOR");
    expect(describeAgentIdentity({ id: "pi-9", source: "pi-session" })).toContain("pi session");
  });
});

describe("notificationIdentity stamps what the filter will compare", () => {
  it("carries the explicit actor as both label and identity", () => {
    expect(notificationIdentity({ VIBEFLOW_ACTOR: "pi-a" })).toEqual({
      actor: "pi-a",
      agent: "pi-a",
    });
  });

  it("carries no identity when nothing resolves — and then suppresses nothing", () => {
    // The switch pins "nothing can resolve" for this call: without it this test
    // would derive the runner's own pi session and prove the opposite.
    const identity = notificationIdentity({ VIBEFLOW_AGENT_IDENTITY: "off" });
    expect(identity.actor).toBe("agent");
    expect(identity.agent).toBeUndefined();
  });
});
