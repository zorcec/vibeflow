/**
 * The generated pi extension must not be able to go quiet (ticket qjsgsnhue).
 *
 * The owner lost a notification after the machine had been idle for hours: the
 * harness had been up 21.6 h, the live follower only 13 minutes, and it carried
 * a `--since` cursor from an hour earlier — a follower had died and a later one
 * resumed from a stale point. The template explained it: the `exit` handler only
 * nulled the child and warned for NON-ZERO codes, so a CLEAN exit — exactly what
 * the follower's own graceful paths produce (SIGHUP, a dead stdout pipe, an
 * orphaned parent; ticket lf6egk9l) — left the feed silently dead for the rest
 * of the session, and any later start began at "now", skipping the gap.
 *
 * Why this harness instead of a string test: asserting the source contains the
 * word "restart" would pass on code that never restarts anything. The real
 * generated source is evaluated here with injected `spawn`/`setTimeout` fakes,
 * so the assertions drive the actual control flow.
 *
 * The source is stripped of its two single-line `import` statements and its
 * `export default` so it can be built with `new Function` — that is also why
 * `spawn`, `existsSync`, `setTimeout` and `clearTimeout` are injected rather
 * than mocked: no module registry, no vitest mock ordering to get wrong.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { renderPiExtension } from "../../../src/core/setup/targets.js";

type FakeChild = EventEmitter & { stdout: PassThrough; kill: () => void };

interface FakePi {
  handlers: Map<string, () => void>;
  on: (name: string, handler: () => void) => void;
  sendMessage: (msg: { content: string }, opts?: unknown) => void;
  registerCommand: (name: string, spec: unknown) => void;
  messages: string[];
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.kill = () => child.emit("exit", null, "SIGTERM");
  return child;
}

function makePi(): FakePi {
  const messages: string[] = [];
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    on: (name, handler) => handlers.set(name, handler),
    messages,
    registerCommand: () => {},
    sendMessage: (msg) => {
      messages.push(String(msg.content));
    },
  };
}

/** Build the extension from its real source with everything it imports faked. */
interface Spawned {
  args: string[];
  child: FakeChild;
}

function loadExtension(): {
  boot: (pi: FakePi) => void;
  spawned: Spawned[];
  /** Followers only: a delivered event also spawns a one-shot detail read. */
  followers: () => Spawned[];
  timers: Array<{ fn: () => void; ms: number }>;
} {
  const source = renderPiExtension("9.9.9", "/opt/vibeflow/cli/index.js", "/tmp/project");
  const body = source
    .replace(/^import .*;$/gm, "")
    .replace(/export default function/, "function __extension");
  expect(body, "the source must be loadable after stripping imports").toContain(
    "function __extension",
  );

  const spawned: Spawned[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];

  const factory = new Function(
    "spawn",
    "existsSync",
    "setTimeout",
    "clearTimeout",
    body + "\nreturn __extension;",
  ) as (
    spawn: (cmd: string, argv: string[], opts?: unknown) => FakeChild,
    existsSync: () => boolean,
    setTimeout: (fn: () => void, ms: number) => { unref?: () => void },
    clearTimeout: (handle: unknown) => void,
  ) => (pi: FakePi) => void;

  const boot = factory(
    (_cmd, argv) => {
      const child = makeChild();
      spawned.push({ args: [...argv], child });
      return child;
    },
    () => true,
    (fn, ms) => {
      timers.push({ fn, ms });
      return { unref: () => {} };
    },
    () => {},
  );

  return {
    boot,
    spawned,
    followers: () => spawned.filter((s) => s.args.includes("--follow")),
    timers,
  };
}

let ext: ReturnType<typeof loadExtension>;
let pi: FakePi;

beforeEach(() => {
  ext = loadExtension();
  pi = makePi();
  ext.boot(pi);
});

const sessionStart = (): void => {
  const handler = pi.handlers.get("session_start");
  expect(handler, "the extension must register a session_start hook").toBeTypeOf("function");
  handler!();
};

describe("generated pi extension supervises its follower (qjsgsnhue)", () => {
  it("warns and restarts after a CLEAN exit, resuming from the last delivered event", () => {
    sessionStart();
    expect(ext.followers()).toHaveLength(1);
    // First start of a session begins now — it must not replay old events.
    const first = ext.followers()[0]!.args;
    expect(first[first.indexOf("--since") + 1]).not.toBe("2026-11-27T17:25:52.950Z");

    // A delivered event sets the resume cursor.
    const delivered = "2026-11-27T17:25:52.950Z";
    ext.followers()[0]!.child.stdout.write(
      JSON.stringify({ id: "evt_1", type: "task.comment", taskId: "t1", ts: delivered }) + "\n",
    );

    // THE BUG: a clean exit used to be completely silent and permanent.
    ext.followers()[0]!.child.emit("exit", 0, null);

    expect(
      pi.messages.some((text) => text.includes("stopped")),
      "a clean exit must be reported — silence is the bug",
    ).toBe(true);
    // The extension owns other timers too (status freshening), so find the
    // retry by its ladder delay rather than by position.
    const retry = ext.timers.find((timer) => timer.ms === 1000);
    expect(retry, "the exit must schedule a restart with the 1 s first step").toBeDefined();

    // The scheduled restart resumes from the delivered event, not from now.
    retry!.fn();
    expect(ext.followers()).toHaveLength(2);
    const second = ext.followers()[1]!.args;
    expect(second[second.indexOf("--since") + 1]).toBe(delivered);
  });

  it("reports ONCE per failure streak, and a delivered line clears the latch", () => {
    sessionStart();
    ext.followers()[0]!.child.emit("exit", 0, null);
    ext.followers()[0]!.child.emit("exit", 0, null);
    const stopMessages = pi.messages.filter((text) => text.includes("stopped"));
    expect(stopMessages).toHaveLength(1);

    // A healthy line resets the ladder and the latch, so a later failure speaks.
    ext.timers.find((timer) => timer.ms === 1000)!.fn();
    ext.followers()[1]!.child.stdout.write(
      JSON.stringify({ id: "evt_2", type: "task.comment", taskId: "t1", ts: "2026-11-27T18:00:00.000Z" }) + "\n",
    );
    ext.followers()[1]!.child.emit("exit", 0, null);
    expect(pi.messages.filter((text) => text.includes("stopped"))).toHaveLength(2);
  });

  it("does not restart after session_shutdown", () => {
    sessionStart();
    const shutdown = pi.handlers.get("session_shutdown");
    expect(shutdown).toBeTypeOf("function");
    shutdown!();
    ext.followers()[0]!.child.emit("exit", 0, null);
    expect(
      ext.timers.filter((timer) => timer.ms >= 1000 && timer.ms <= 60000),
      "shutdown must cancel any pending restart",
    ).toHaveLength(0);
  });
});
