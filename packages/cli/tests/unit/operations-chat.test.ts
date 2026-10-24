/**
 * Agent-chat page-read operation pins (ticket 453c7465, P7 chat increment).
 *
 * `readPageText` and `readPageDom` are the classified wrappers behind the
 * chat-only `read_page_text` / `read_page_dom` tools. They own no fetch,
 * DNS, DOM, or approval policy — the injected `run` port does — so these
 * pins drive them against fakes and assert the verbatim contract the
 * dispatcher relies on:
 *
 * - the raw tool input reaches the runner untouched (validation, SSRF
 *   blocking, caps, and `<untrusted-webpage>` wrapping stay in the real
 *   `runReadPageText`/`runReadPageDom`, pinned by the existing
 *   agent-chat-mcp suite);
 * - the runner's result — ok payload or refusal — returns verbatim, so
 *   the wire shape is identical to the inline dispatch this replaces;
 * - the DOM read threads its chat `sessionId` and tab round-trip hook
 *   through unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "../../src/core/operations.js";
import {
  readPageText,
  readPageDom,
} from "../../src/core/operations.js";
import type {
  ReadPageTextRunner,
  ReadPageDomRunner,
  RequestBrowserDomFn,
} from "../../src/core/operations.js";
import type { ChatMcpTextResult } from "../../src/server/agent-chat/mcp.js";

const ctx: OperationContext = { projectDir: "/tmp/p7-chat-test", mode: "local" };

function okText(payload: unknown): ChatMcpTextResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function refusal(code: string, message: string): ChatMcpTextResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ ok: false, error: { code, message } }) },
    ],
    isError: true,
  };
}

describe("readPageText", () => {
  it("forwards the raw tool input verbatim and returns the result verbatim", async () => {
    const input = { url: "https://example.com/reference" };
    const result = okText({ url: input.url, text: "hello", truncated: false });
    const run = vi.fn<ReadPageTextRunner>(async () => result);
    const out = await readPageText(ctx, { input, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(input, undefined, undefined);
    expect(out).toBe(result);
  });

  it("forwards injected fetch and DNS ports to the runner", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const resolveHost = vi.fn(async (_h: string) => ["93.184.216.34"]);
    const run = vi.fn<ReadPageTextRunner>(async () => okText({}));
    await readPageText(ctx, {
      input: { url: "https://example.com/" },
      run,
      fetchImpl,
      resolveHost,
    });
    expect(run).toHaveBeenCalledWith(
      { url: "https://example.com/" },
      fetchImpl,
      resolveHost,
    );
  });

  it("passes refusals through untouched, error flag included", async () => {
    const denied = refusal("BLOCKED_HOST", "refusing to fetch example.internal");
    const run = vi.fn<ReadPageTextRunner>(async () => denied);
    const out = await readPageText(ctx, { input: { url: "http://example.internal/" }, run });
    expect(out).toBe(denied);
    expect(out.isError).toBe(true);
  });
});

describe("readPageDom", () => {
  it("threads session id, raw input, and tab hook through verbatim", async () => {
    const input = { selector: "#checkout" };
    const result = okText({ text: "buy now", truncated: false });
    const requestDom = vi.fn<RequestBrowserDomFn>(async () => ({
      text: "buy now",
      found: true,
    }));
    const run = vi.fn<ReadPageDomRunner>(async () => result);
    const out = await readPageDom(ctx, {
      sessionId: "sess-1",
      input,
      run,
      requestDom,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("sess-1", input, requestDom);
    expect(out).toBe(result);
  });

  it("passes deterministic DOM refusals through untouched", async () => {
    const timeout = refusal(
      "TIMEOUT",
      "the chat page did not answer in time (tab closed or overlay offline)",
    );
    const run = vi.fn<ReadPageDomRunner>(async () => timeout);
    const requestDom = vi.fn<RequestBrowserDomFn>(async () => null);
    const out = await readPageDom(ctx, {
      sessionId: "sess-9",
      input: {},
      run,
      requestDom,
    });
    expect(out).toBe(timeout);
    expect(run).toHaveBeenCalledWith("sess-9", {}, requestDom);
  });
});
