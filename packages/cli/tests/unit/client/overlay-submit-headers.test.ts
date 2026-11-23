import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * `submitTask` is the overlay's CREATE call. The SaaS overlay route
 * (`POST /api/overlay/tasks`) authorises a write with either a same-origin
 * session cookie or the board's `x-overlay-api-key`; a page that embeds the
 * overlay is by definition on ANOTHER origin, so it has no session cookie and
 * the key is the only door. The bundle already sends that key on GET
 * (`fetchTasks`) and on PATCH/DELETE (`mutationHeaders`) — this suite pins it
 * on the create too. Without it every annotation on a customer page answered
 * 401 and the popover closed as if saved (ticket z0hwonzx).
 *
 * The bundle reads `PROTO_CONFIG` as a free global (injected by the SaaS route
 * or the CLI bundler), so each case re-imports the module with a fresh one.
 */

type Recorded = { url: string; init: RequestInit };
const g = globalThis as unknown as Record<string, unknown>;

function installBrowserGlobals(overlayApiKey?: string): Recorded[] {
  const calls: Recorded[] = [];
  g.PROTO_CONFIG = {
    port: 0,
    wsUrl: "",
    apiUrl: "https://app.vibeflow.tools/api/overlay/tasks",
    pagesUrl: "",
    screenshotsUrl: "",
    boardId: "board-1",
    overlayApiKey,
  };
  g.location = { origin: "https://customer.example" };
  g.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ success: true }), {
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

async function submit() {
  vi.resetModules();
  const api = await import("../../../src/client/overlay-browser/api.js");
  return api.submitTask(".cta", "#cta", "Broken button", "It does nothing");
}

afterEach(() => {
  delete g.PROTO_CONFIG;
  delete g.location;
  delete g.fetch;
});

describe("submitTask headers", () => {
  it("sends the board's overlay API key so a foreign-origin create is authorised", async () => {
    const calls = installBrowserGlobals("a".repeat(64));
    await submit();

    const post = calls.find((c) => c.init.method === "POST");
    expect(post, "a POST reached fetch").toBeDefined();
    expect(post!.url).toBe("https://app.vibeflow.tools/api/overlay/tasks");
    const headers = post!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Overlay-Api-Key"]).toBe("a".repeat(64));
  });

  it("sends no key when the snippet carries none (local CLI server trusts the page)", async () => {
    const calls = installBrowserGlobals(undefined);
    await submit();

    const post = calls.find((c) => c.init.method === "POST");
    expect(post, "a POST reached fetch").toBeDefined();
    const headers = post!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Overlay-Api-Key"]).toBeUndefined();
  });
});
