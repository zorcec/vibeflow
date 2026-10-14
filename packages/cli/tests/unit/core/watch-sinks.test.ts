import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyWebhookSignature } from "@vibeflow-tools/shared";
import {
  createSink,
  webhookSink,
} from "../../../src/core/watch-sinks.js";
import type { WatchEvent } from "../../../src/core/watch-events.js";

const EVENT: WatchEvent = {
  type: "new",
  taskId: "task-aaa",
  timestamp: "2026-09-07T10:00:00.000Z",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(impl: (url: string, init: RequestInit) => unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return impl(url, init);
    }),
  );
  return calls;
}

const ok = () => ({ ok: true, status: 200 });

describe("webhookSink signing", () => {
  it("sends the signature header when a secret is set", async () => {
    const calls = stubFetch(ok);
    webhookSink("https://example.test/hook", { secret: "s3cret" }).emit(EVENT);
    await sleep(50);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    const headerValue = headers["X-Vibeflow-Signature"];
    expect(headerValue).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    // The signature verifies against the exact bytes sent.
    expect(
      verifyWebhookSignature("s3cret", calls[0]!.init.body as string, headerValue),
    ).toBe(true);
    // Body is the same envelope as the unsigned sink.
    expect(calls[0]!.init.body).toBe(JSON.stringify(EVENT));
  });

  it("sends NO signature header when no secret is set (byte-identical to before)", async () => {
    const calls = stubFetch(ok);
    webhookSink("https://example.test/hook").emit(EVENT);
    await sleep(50);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(calls[0]!.init.body).toBe(JSON.stringify(EVENT));
  });

  it("createSink passes webhookSecret through to the webhook sink", async () => {
    const calls = stubFetch(ok);
    const sink = createSink({
      webhook: "https://example.test/hook",
      webhookSecret: "board-secret",
    });
    sink.emit(EVENT);
    await sleep(50);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Vibeflow-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("keeps fire-and-forget + 1 retry on failure", async () => {
    const calls = stubFetch((_, __) => ({ ok: false, status: 500 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    webhookSink("https://example.test/hook").emit(EVENT);
    await sleep(100);
    // Initial attempt + exactly one retry.
    expect(calls).toHaveLength(2);
    expect(errSpy).not.toHaveBeenCalled();
  });
});
