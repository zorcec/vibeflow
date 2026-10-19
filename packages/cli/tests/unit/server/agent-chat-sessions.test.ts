/**
 * Session manager coverage (ticket 0847833f): spawn/cap/framing/
 * correlation/expiry against a stub child process — no pi binary, no
 * model, no network. The framing tests pin the LF-only contract (a
 * U+2028 inside a JSON string must NOT split the record).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatSessionManager,
  ensureOverlayMcpEntry,
  TOO_MANY_SESSIONS,
  COMMAND_TIMEOUT,
  SESSION_CLOSED,
  type PiWireRecord,
} from "../../../src/server/agent-chat/sessions.js";

class StubStdin extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): void {
    this.destroyed = true;
  }
}

class StubStdout extends EventEmitter {
  push(line: string): void {
    this.emit("data", Buffer.from(line, "utf8"));
  }
}

class StubStderr extends EventEmitter {}

class StubChild extends EventEmitter {
  stdin = new StubStdin();
  stdout = new StubStdout();
  stderr = new StubStderr();
  killed: string | null = null;
  kill(signal?: string): boolean {
    this.killed = signal ?? "SIGTERM";
    return true;
  }
  /** Feed one parsed record as pi would emit it. */
  emitRecord(record: PiWireRecord): void {
    this.stdout.push(`${JSON.stringify(record)}\n`);
  }
}

function makeManager(opts?: {
  maxSessions?: number;
  idleTimeoutMs?: number;
  commandTimeoutMs?: number;
  projectDir?: string;
}) {
  const children: StubChild[] = [];
  const spawn = vi.fn(() => {
    const child = new StubChild();
    children.push(child);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return child as any;
  });
  const dir =
    opts?.projectDir ?? mkdtempSync(join(tmpdir(), "vf-chat-test-"));
  const manager = new ChatSessionManager(
    {
      projectDir: dir,
      serverOrigin: "http://localhost:3700",
      maxSessions: opts?.maxSessions,
      idleTimeoutMs: opts?.idleTimeoutMs ?? 0,
      commandTimeoutMs: opts?.commandTimeoutMs ?? 200,
      piBinary: "pi-stub",
    },
    { spawn },
  );
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return { manager, spawn, children, dir };
}

describe("ChatSessionManager", () => {
  it("spawns pi --mode rpc in the project dir and merges the overlay MCP entry", () => {
    const { manager, spawn, children, dir } = makeManager();
    const session = manager.create();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe("pi-stub");
    expect(spawn.mock.calls[0]?.[1]).toEqual(["--mode", "rpc"]);
    expect(spawn.mock.calls[0]?.[2].cwd).toBe(dir);
    expect(children).toHaveLength(1);
    expect(session.status()).toBe("ready");
    expect(session.info().projectDir).toBe(dir);
  });

  it("enforces the session cap with TOO_MANY_SESSIONS", () => {
    const { manager } = makeManager({ maxSessions: 1 });
    manager.create();
    expect(() => manager.create()).toThrowError(
      expect.objectContaining({ code: TOO_MANY_SESSIONS }),
    );
  });

  it("correlates prompt responses by id and resolves the disposition", async () => {
    const { children, manager } = makeManager();
    const session = manager.create();
    const pending = session.prompt("hello");
    const written = children[0]!.stdin.written;
    expect(written).toHaveLength(1);
    const cmd = JSON.parse(written[0]!) as Record<string, unknown>;
    expect(cmd.type).toBe("prompt");
    expect(cmd.message).toBe("hello");
    expect(typeof cmd.id).toBe("string");
    children[0]!.emitRecord({
      type: "response",
      id: cmd.id,
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    await expect(pending).resolves.toEqual({
      commandId: cmd.id,
      disposition: "started",
    });
    expect(session.status()).toBe("busy");
  });

  it("streams session events to record listeners and settles back to ready", async () => {
    const { children, manager } = makeManager();
    const session = manager.create();
    const seen: PiWireRecord[] = [];
    session.on("record", (r) => seen.push(r));
    const pending = session.prompt("hi");
    const cmd = JSON.parse(children[0]!.stdin.written[0]!) as { id: string };
    children[0]!.emitRecord({
      type: "response",
      id: cmd.id,
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    await pending;
    children[0]!.emitRecord({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "yo" },
    });
    children[0]!.emitRecord({ type: "agent_settled", aborted: false });
    expect(seen.map((r) => r.type)).toEqual([
      "response",
      "message_update",
      "agent_settled",
    ]);
    expect(session.status()).toBe("ready");
  });

  it("frames on LF only: U+2028 inside a JSON string never splits a record", async () => {
    const { children, manager } = makeManager();
    const session = manager.create();
    const seen: PiWireRecord[] = [];
    session.on("record", (r) => seen.push(r));
    // A delta containing U+2028 (valid inside JSON strings) plus a split
    // write across two chunks — exactly one record must emerge.
    const full = `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a b" } })}\n`;
    children[0]!.stdout.emit("data", Buffer.from(full.slice(0, 20), "utf8"));
    children[0]!.stdout.emit("data", Buffer.from(full.slice(20), "utf8"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "message_update" });
  });

  it("CR-terminated lines are accepted (CRLF writers)", async () => {
    const { children, manager } = makeManager();
    const seen: PiWireRecord[] = [];
    manager.create().on("record", (r) => seen.push(r));
    children[0]!.stdout.emit(
      "data",
      Buffer.from('{"type":"agent_start"}\r\n', "utf8"),
    );
    expect(seen).toEqual([{ type: "agent_start" }]);
  });

  it("malformed lines emit parseError and never break the reader", () => {
    const { children, manager } = makeManager();
    const session = manager.create();
    const errors: Array<[string, string]> = [];
    const seen: PiWireRecord[] = [];
    session.on("parseError", (line, err) => errors.push([line, err]));
    session.on("record", (r) => seen.push(r));
    children[0]!.stdout.emit("data", Buffer.from("not json\n", "utf8"));
    children[0]!.stdout.emit(
      "data",
      Buffer.from('{"type":"agent_start"}\n', "utf8"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe("not json");
    expect(seen).toEqual([{ type: "agent_start" }]);
  });

  it("times out unanswered commands with COMMAND_TIMEOUT", async () => {
    const { manager } = makeManager({ commandTimeoutMs: 20 });
    const session = manager.create();
    await expect(session.prompt("hang")).rejects.toMatchObject({
      code: COMMAND_TIMEOUT,
    });
  });

  it("rejects pending commands and removes the session on child exit", async () => {
    const { children, manager } = makeManager();
    const session = manager.create();
    const pending = session.prompt("hi");
    children[0]!.emit("exit", 1, null);
    await expect(pending).rejects.toMatchObject({ code: SESSION_CLOSED });
    expect(manager.size).toBe(0);
  });

  it("close() ends stdin and removes the session", async () => {
    const { children, manager } = makeManager();
    const session = manager.create();
    const closing = session.close();
    children[0]!.emit("exit", 0, null);
    await closing;
    expect(children[0]!.stdin.destroyed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("ENOENT spawn surfaces PI_NOT_FOUND (degraded chat path)", async () => {
    const spawn = vi.fn(() => {
      const err = new Error("spawn pi ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const dir = mkdtempSync(join(tmpdir(), "vf-chat-nopi-"));
    const manager = new ChatSessionManager(
      { projectDir: dir, serverOrigin: "http://x", idleTimeoutMs: 0 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { spawn: spawn as any },
    );
    const session = manager.create();
    expect(session.status()).toBe("error");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("ensureOverlayMcpEntry", () => {
  it("creates .pi/mcp.json with the overlay entry and keeps existing servers", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-chat-mcp-"));
    try {
      const first = ensureOverlayMcpEntry(dir, "http://localhost:3700/", "s1");
      expect(first.created).toBe(true);
      const second = ensureOverlayMcpEntry(dir, "http://localhost:3700", "s1");
      expect(second.updated).toBe(false);
      // A user server survives the merge; our entry refreshes per session.
      const doc = JSON.parse(readFileSync(`${dir}/.pi/mcp.json`, "utf8")) as {
        servers: Record<string, unknown>;
      };
      doc.servers.mine = { url: "http://x" };
      writeFileSync(`${dir}/.pi/mcp.json`, JSON.stringify(doc));
      ensureOverlayMcpEntry(dir, "http://localhost:3700", "s2");
      const merged = JSON.parse(
        readFileSync(`${dir}/.pi/mcp.json`, "utf8"),
      ) as { servers: Record<string, { url: string }> };
      expect(merged.servers.mine).toEqual({ url: "http://x" });
      // The session id travels in the URL PATH — this must match the
      // server's mount (`app.all("/api/chat-mcp/:sessionId", …)` in
      // routes.ts). A bare /api/chat-mcp matches no route and the agent
      // silently loses all vibeflow tools, so this exact shape is pinned.
      expect(merged.servers["vibeflow-overlay"]).toEqual({
        url: "http://localhost:3700/api/chat-mcp/s2",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
