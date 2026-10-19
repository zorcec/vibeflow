/**
 * Routes coverage (ticket 0847833f): session REST, message intake,
 * approvals, browser round-trips, and the per-session chat MCP mount —
 * all over real HTTP against an ephemeral Express app. No pi binary, no
 * model, no network beyond localhost.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  ChatSessionManager,
  type PiWireRecord,
} from "../../../src/server/agent-chat/sessions.js";
import {
  registerChatRoutes,
  requestApproval,
  requestBrowserDom,
} from "../../../src/server/agent-chat/routes.js";

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
class StubChild extends EventEmitter {
  stdin = new StubStdin();
  stdout = new StubStdout();
  stderr = new EventEmitter();
  kill(): boolean {
    return true;
  }
  emitRecord(record: PiWireRecord): void {
    this.stdout.push(`${JSON.stringify(record)}\n`);
  }
}

interface Harness {
  base: string;
  broadcasts: Array<Record<string, unknown>>;
  children: StubChild[];
  manager: ChatSessionManager;
  dir: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const children: StubChild[] = [];
  const spawn = vi.fn(() => {
    const child = new StubChild();
    children.push(child);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return child as any;
  });
  const dir = mkdtempSync(join(tmpdir(), "vf-chat-routes-"));
  const manager = new ChatSessionManager(
    { projectDir: dir, serverOrigin: "http://127.0.0.1:0", idleTimeoutMs: 0, commandTimeoutMs: 200 },
    { spawn },
  );
  const broadcasts: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  registerChatRoutes(app, {
    manager,
    broadcast: (data) => broadcasts.push(data),
    projectDir: dir,
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    broadcasts,
    children,
    manager,
    dir,
    close: async () => {
      await manager.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function post(base: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null, headers: res.headers };
}

describe("chat REST surface", () => {
  it("status reports the gate and pi availability shape", async () => {
    const h = await startHarness();
    try {
      const res = await fetch(`${h.base}/api/chat/status`);
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(body.enabled).toBe(true);
      expect(typeof body.piAvailable).toBe("boolean");
      expect(body.active).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("session lifecycle: create → message → broadcast mapped events → delete", async () => {
    const h = await startHarness();
    try {
      const created = await post(h.base, "/api/chat/sessions", {});
      expect(created.status).toBe(200);
      const sessionId = (created.body as { sessionId: string }).sessionId;
      expect(typeof sessionId).toBe("string");

      // Fire the POST without awaiting: the handler waits for pi's
      // accept, which the stub emits below (same deadlock the real
      // client avoids by streaming WS events while POST is in flight).
      const msgPromise = post(h.base, `/api/chat/${sessionId}/message`, {
        message: "hi",
        page: { url: "https://docs.example.net/p", title: "P" },
      });
      await vi.waitFor(() => {
        expect(h.children[0]!.stdin.written.length).toBe(1);
      });
      // Drive the stub child: accept + one token + settle.
      const sent = JSON.parse(h.children[0]!.stdin.written[0]!) as { id: string };
      h.children[0]!.emitRecord({
        type: "response",
        id: sent.id,
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      const msg = await msgPromise;
      expect(msg.status).toBe(200);
      expect((msg.body as { accepted: boolean }).accepted).toBe(true);
      // Regression pin (review P1): images must travel top-level on the
      // RPC prompt command — never nested, never dropped.
      expect(sent).not.toHaveProperty("images");
      h.children[0]!.emitRecord({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "yo" },
      });
      h.children[0]!.emitRecord({ type: "agent_settled", aborted: false });
      const kinds = h.broadcasts.map((b) => b.type);
      expect(kinds).toEqual(["agent:token", "agent:done"]);
      expect(h.broadcasts[0]).toMatchObject({ sessionId, delta: "yo" });

      const del = await fetch(`${h.base}/api/chat/${sessionId}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      const delAgain = await fetch(`${h.base}/api/chat/${sessionId}`, { method: "DELETE" });
      expect(delAgain.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("forwards images top-level on the pi prompt command (review P1)", async () => {
    const h = await startHarness();
    try {
      const created = await post(h.base, "/api/chat/sessions", {});
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const msgPromise = post(h.base, `/api/chat/${sessionId}/message`, {
        message: "look",
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      });
      await vi.waitFor(() => {
        expect(h.children[0]!.stdin.written.length).toBe(1);
      });
      const sent = JSON.parse(h.children[0]!.stdin.written[0]!) as Record<string, unknown>;
      // Top-level per the RPC contract — the agent actually receives them.
      expect(sent.images).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
      expect(sent).not.toHaveProperty("metadata");
      h.children[0]!.emitRecord({
        type: "response",
        id: sent.id,
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      const msg = await msgPromise;
      expect(msg.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it("drops malformed image entries instead of forwarding them", async () => {
    const h = await startHarness();
    try {
      const created = await post(h.base, "/api/chat/sessions", {});
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const msgPromise = post(h.base, `/api/chat/${sessionId}/message`, {
        message: "look",
        images: [{ type: "image", data: 42 }, "junk", null],
      });
      await vi.waitFor(() => {
        expect(h.children[0]!.stdin.written.length).toBe(1);
      });
      const sent = JSON.parse(h.children[0]!.stdin.written[0]!) as Record<string, unknown>;
      expect(sent).not.toHaveProperty("images");
      h.children[0]!.emitRecord({
        type: "response",
        id: (sent as { id: string }).id,
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      const msg = await msgPromise;
      expect(msg.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it("abort interrupts the run and 404s unknown sessions", async () => {
    const h = await startHarness();
    try {
      const missing = await post(h.base, "/api/chat/nope/abort", {});
      expect(missing.status).toBe(404);
      const created = await post(h.base, "/api/chat/sessions", {});
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const res = await post(h.base, `/api/chat/${sessionId}/abort`, {});
      expect(res.status).toBe(200);
      expect((res.body as { aborted: boolean }).aborted).toBe(true);
      // The abort command reached the pi child.
      const sent = JSON.parse(h.children[0]!.stdin.written[0]!) as Record<string, unknown>;
      expect(sent.type).toBe("abort");
    } finally {
      await h.close();
    }
  });

  it("message validation: unknown session 404, empty message 400", async () => {
    const h = await startHarness();
    try {
      const unknown = await post(h.base, "/api/chat/nope/message", { message: "hi" });
      expect(unknown.status).toBe(404);
      const created = await post(h.base, "/api/chat/sessions", {});
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const empty = await post(h.base, `/api/chat/${sessionId}/message`, { message: "  " });
      expect(empty.status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it("approvals: broadcast card, approve resolves true, unknown id 404s", async () => {
    const h = await startHarness();
    try {
      const pending = requestApproval(
        (d) => h.broadcasts.push(d),
        "sess-1",
        "update_task",
        '{"id":"t1"}',
      );
      const card = h.broadcasts.find((b) => b.type === "agent:approval-request") as {
        approvalId: string;
      };
      expect(card.toolName).toBe("update_task");
      const res = await post(h.base, `/api/chat/approvals/${card.approvalId}`, {
        approved: true,
      });
      expect(res.status).toBe(200);
      await expect(pending).resolves.toBe(true);

      const missing = await post(h.base, "/api/chat/approvals/nope", { approved: true });
      expect(missing.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("approval deny resolves false (fail-closed the agent can explain)", async () => {
    const h = await startHarness();
    try {
      const pending = requestApproval(
        (d) => h.broadcasts.push(d),
        "sess-1",
        "delete_task",
        "{}",
      );
      const card = h.broadcasts.find((b) => b.type === "agent:approval-request") as {
        approvalId: string;
      };
      await post(h.base, `/api/chat/approvals/${card.approvalId}`, { approved: false });
      await expect(pending).resolves.toBe(false);
    } finally {
      await h.close();
    }
  });

  it("DOM round-trip: tool-result resolves the text, unknown request 404s", async () => {
    const h = await startHarness();
    try {
      const created = await post(h.base, "/api/chat/sessions", {});
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const pending = requestBrowserDom(
        (d) => h.broadcasts.push(d),
        sessionId,
        "#pay",
      );
      const ask = h.broadcasts.find((b) => b.type === "agent:tool-request") as {
        requestId: string;
      };
      expect(ask.kind).toBe("read_dom");
      const res = await post(h.base, `/api/chat/${sessionId}/tool-result`, {
        requestId: ask.requestId,
        payload: { text: "Pay now", found: true },
      });
      expect(res.status).toBe(200);
      await expect(pending).resolves.toEqual({ text: "Pay now", found: true });

      const missing = await post(h.base, `/api/chat/${sessionId}/tool-result`, {
        requestId: "nope",
        payload: {},
      });
      expect(missing.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("chat MCP rejects unknown chat sessions before touching MCP", async () => {
    const h = await startHarness();
    try {
      const res = await post(h.base, "/api/chat-mcp/nope", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      expect(res.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("chat MCP handshake works and lists chat + website tools", async () => {
    const h = await startHarness();
    try {
      const created = await post(h.base, "/api/chat/sessions", {});
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const init = await fetch(`${h.base}/api/chat-mcp/${sessionId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        }),
      });
      expect(init.status).toBe(200);
      const mcpSession = init.headers.get("mcp-session-id");
      expect(typeof mcpSession).toBe("string");
      const list = await fetch(`${h.base}/api/chat-mcp/${sessionId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": mcpSession!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(list.status).toBe(200);
      const names = (
        ((await list.json()) as { result?: { tools?: Array<{ name: string }> } }).result
          ?.tools ?? []
      ).map((t) => t.name);
      expect(names).toContain("read_page_text");
      expect(names).toContain("read_page_dom");
      expect(names).toContain("list_tasks");
    } finally {
      await h.close();
    }
  });
});
