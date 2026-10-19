/**
 * Coverage for the chat MCP layer (ticket 0847833f):
 * - website text extraction + untrusted wrap (pure, dependency-free)
 * - approval gate: reads run free, mutating tools pause for approval,
 *   denial/timeout fail closed with APPROVAL_DENIED
 * - read_page_text: validation, fetch errors, type gating, caps
 * - read_page_dom: round-trip hit/miss mapping
 */
import { describe, it, expect, vi } from "vitest";
import {
  extractPageText,
  wrapUntrusted,
  isBlockedIp,
  isBlockedHostname,
} from "../../../src/server/agent-chat/website.js";

describe("SSRF guard (isBlockedIp / isBlockedHostname)", () => {
  it("blocks loopback, private, link-local, and reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1", "127.9.9.9", "10.0.0.1", "10.255.255.255",
      "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254",
      "224.0.0.1", "0.0.0.0", "255.255.255.255",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    // Boundary: just outside the private ranges stays fetchable.
    for (const ip of ["11.0.0.1", "172.15.255.255", "172.32.0.1", "192.167.0.1", "93.184.216.34", "8.8.8.8"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 loopback, link-local, unique-local, multicast", () => {
    for (const ip of ["::1", "::", "fe80::1", "FE80::A", "fc00::1", "fd12::99", "ff02::1", "::ffff:127.0.0.1", "[::1]"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });

  it("blocks non-public DNS names, case-insensitively, with trailing dots", () => {
    for (const host of ["localhost", "LOCALHOST", "app.local", "svc.internal.", "x.invalid", "x.test", "x.example", "127.0.0.1", "[::1]"]) {
      expect(isBlockedHostname(host), host).toBe(true);
    }
    expect(isBlockedHostname("example.com")).toBe(false);
    expect(isBlockedHostname("sub.domain.co.uk")).toBe(false);
    expect(isBlockedHostname("my-intranet")).toBe(false);
    expect(isBlockedHostname("")).toBe(true);
  });
});
import {
  makeGatedRunner,
  runReadPageText,
  runReadPageDom,
  APPROVAL_DENIED,
} from "../../../src/server/agent-chat/mcp.js";
import type { ToolManifest } from "../../../src/mcp/manifest.js";

describe("extractPageText", () => {
  it("strips scripts, styles, and tags, keeps readable text", () => {
    const html = `<html><head><style>.a{color:red}</style><script>alert(1)</script></head>
      <body><h1>Title</h1><p>Hello <b>world</b></p><!-- comment --></body></html>`;
    const text = extractPageText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello world");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("comment");
  });

  it("decodes common entities", () => {
    expect(extractPageText("<p>a &amp; b &lt;c&gt; &#39;q&#39;</p>")).toBe(
      "a & b <c> 'q'",
    );
  });

  it("collapses whitespace, empty input stays empty", () => {
    expect(extractPageText("")).toBe("");
    expect(extractPageText("<p>  a   b  </p>")).toBe("a b");
  });
});

describe("wrapUntrusted", () => {
  it("marks content as third-party data with its source", () => {
    const out = wrapUntrusted("Click here", "https://docs.example.net/p");
    expect(out).toContain("<untrusted-webpage");
    expect(out).toContain("Click here");
    expect(out).not.toContain("<script>");
  });

  it("sanitizes the source attribute", () => {
    const out = wrapUntrusted("x", 'a"><b');
    expect(out).not.toContain('"><');
  });
});

function fakeTool(readOnly: boolean): ToolManifest {
  return {
    name: "fake_mut",
    title: "Fake",
    description: "d",
    cliRef: { command: "tasks", flags: [] },
    category: "task-write",
    annotations: { readOnlyHint: readOnly },
    input: {},
    schema: {},
    run: vi.fn().mockResolvedValue({ ok: true, data: { did: 1 } }),
  } as unknown as ToolManifest;
}

const baseCtx = { projectDir: "/tmp", mode: "local" as const };

describe("makeGatedRunner", () => {
  it("runs read-only tools without consulting approvals", async () => {
    const tool = fakeTool(true);
    const requestApproval = vi.fn();
    const run = makeGatedRunner("s1", tool, baseCtx, {
      approvalsEnabled: () => true,
      requestApproval,
    });
    const out = (await run({ a: 1 })) as { content: Array<{ text: string }> };
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ did: 1 });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(tool.run).toHaveBeenCalledTimes(1);
  });

  it("runs mutating tools straight through when approvals are off", async () => {
    const tool = fakeTool(false);
    const requestApproval = vi.fn();
    const run = makeGatedRunner("s1", tool, baseCtx, {
      approvalsEnabled: () => false,
      requestApproval,
    });
    await run({});
    expect(requestApproval).not.toHaveBeenCalled();
    expect(tool.run).toHaveBeenCalledTimes(1);
  });

  it("pauses mutating tools for approval and proceeds on approve", async () => {
    const tool = fakeTool(false);
    const requestApproval = vi.fn().mockResolvedValue(true);
    const run = makeGatedRunner("s1", tool, baseCtx, {
      approvalsEnabled: () => true,
      requestApproval,
    });
    const out = (await run({ id: "t1" })) as { content: Array<{ text: string }> };
    expect(requestApproval).toHaveBeenCalledWith(
      "s1",
      "fake_mut",
      expect.any(String),
    );
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ did: 1 });
  });

  it("unannotated tools are gated, not free (fail-closed default)", async () => {
    const tool = fakeTool(true);
    delete (tool as { annotations?: unknown }).annotations;
    const requestApproval = vi.fn().mockResolvedValue(true);
    const run = makeGatedRunner("s1", tool, baseCtx, {
      approvalsEnabled: () => true,
      requestApproval,
    });
    await run({});
    // No readOnlyHint: true anywhere → treated as mutating → gated.
    expect(requestApproval).toHaveBeenCalledTimes(1);
    // Break: gate on `!== false` — an unannotated future tool runs
    // unapproved and the approval card is decoration for it.
  });

  it("denial fails closed with APPROVAL_DENIED and never runs the tool", async () => {
    const tool = fakeTool(false);
    const run = makeGatedRunner("s1", tool, baseCtx, {
      approvalsEnabled: () => true,
      requestApproval: vi.fn().mockResolvedValue(false),
    });
    const out = (await run({ id: "t1" })) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain(APPROVAL_DENIED);
    expect(tool.run).not.toHaveBeenCalled();
    // Break: run the tool despite denial — board mutations escape review
    // and the approval card is decoration.
  });
});

describe("runReadPageText", () => {
  // Public documentation IP (RFC 5737) — never routes anywhere real,
  // never blocked by the SSRF guard. Keeps page-fetch tests hermetic.
  const PUBLIC_IP = "203.0.113.7";
  const publicDns = async () => [PUBLIC_IP];

  function htmlResponse(html: string, contentType = "text/html") {
    return {
      ok: true,
      status: 200,
      headers: { get: () => contentType },
      text: () => Promise.resolve(html),
    };
  }

  it("extracts and wraps page text", async () => {
    const out = await runReadPageText(
      { url: "https://docs.example.net/p" },
      (async () => htmlResponse("<h1>Hi</h1><p>there</p>")) as unknown as typeof fetch,
      publicDns,
    );
    const body = JSON.parse(out.content[0]!.text) as { text: string };
    expect(body.text).toContain("Hi");
    expect(body.text).toContain("<untrusted-webpage");
  });

  it("refuses non-http URLs without fetching", async () => {
    const fetchMock = vi.fn();
    const out = (await runReadPageText(
      { url: "file:///etc/passwd" },
      fetchMock as unknown as typeof fetch,
    )) as { isError: boolean };
    expect(out.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses non-text content types", async () => {
    const out = (await runReadPageText(
      { url: "https://docs.example.net/logo.png" },
      (async () =>
        htmlResponse("raw", "image/png")) as unknown as typeof fetch,
      publicDns,
    )) as { isError: boolean };
    expect(out.isError).toBe(true);
  });

  it("maps fetch failures to FETCH_FAILED, never throws", async () => {
    const out = (await runReadPageText(
      { url: "https://docs.example.net/" },
      (async () => {
        throw new Error("dns");
      }) as unknown as typeof fetch,
      publicDns,
    )) as { isError: boolean };
    expect(out.isError).toBe(true);
  });

  it("refuses loopback, private, and link-local literals without fetching", async () => {
    const fetchMock = vi.fn();
    for (const url of [
      "http://127.0.0.1/latest/meta-data/",
      "http://10.0.0.5/",
      "http://192.168.1.1/admin",
      "http://169.254.169.254/latest/meta-data/iam/",
      "http://[::1]/",
      "http://localhost:3000/x",
    ]) {
      const out = (await runReadPageText(
        { url },
        fetchMock as unknown as typeof fetch,
        publicDns,
      )) as { content: Array<{ text: string }>; isError: boolean };
      expect(out.isError, url).toBe(true);
      expect(out.content[0]!.text, url).toContain("BLOCKED_HOST");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    // Break: fetch first, guard later — a crafted link exfiltrates the
    // cloud instance identity document into the chat transcript.
  });

  it("refuses hosts that resolve to non-routable IPs", async () => {
    const fetchMock = vi.fn();
    const out = (await runReadPageText(
      { url: "https://evil.example.internal/" },
      fetchMock as unknown as typeof fetch,
      async () => ["10.9.9.9"],
    )) as { content: Array<{ text: string }>; isError: boolean };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("BLOCKED_HOST");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses unresolvable hosts (fail closed, no fetch)", async () => {
    const fetchMock = vi.fn();
    const out = (await runReadPageText(
      { url: "https://nxdomain-12345.test/" },
      fetchMock as unknown as typeof fetch,
      async () => {
        throw new Error("ENOTFOUND");
      },
    )) as { isError: boolean };
    expect(out.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks every redirect hop, not just the first URL", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      seen.push(u);
      if (u === "https://docs.example.net/start") {
        return {
          ok: false,
          status: 302,
          headers: { get: (k: string) => (k === "location" ? "http://169.254.169.254/oops" : null) },
          text: () => Promise.resolve(""),
        };
      }
      throw new Error(`unexpected fetch of ${u}`);
    });
    const out = (await runReadPageText(
      { url: "https://docs.example.net/start" },
      fetchMock as unknown as typeof fetch,
      publicDns,
    )) as { content: Array<{ text: string }>; isError: boolean };
    // The redirect target is blocked BEFORE any second request fires.
    expect(seen).toEqual(["https://docs.example.net/start"]);
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("BLOCKED_HOST");
    // Break: follow redirects with undici defaults — a Location to
    // link-local sails through and the metadata service answers.
  });
});

describe("runReadPageDom", () => {
  it("wraps the tab text as untrusted live-dom", async () => {
    const out = await runReadPageDom(
      "s1",
      { selector: "#pay" },
      vi.fn().mockResolvedValue({ text: "Pay now $49", found: true }),
    );
    const body = JSON.parse(out.content[0]!.text) as { text: string };
    expect(body.text).toContain("Pay now $49");
    expect(body.text).toContain('source="live-dom"');
  });

  it("null tab answer becomes a TIMEOUT refusal, never a throw", async () => {
    const out = (await runReadPageDom("s1", {}, vi.fn().mockResolvedValue(null))) as {
      isError: boolean;
    };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("TIMEOUT");
  });

  it("unmatched selector becomes ELEMENT_NOT_FOUND, not an empty ok", async () => {
    const out = (await runReadPageDom(
      "s1",
      { selector: "#missing" },
      vi.fn().mockResolvedValue({ text: "", found: false }),
    )) as { isError: boolean };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("ELEMENT_NOT_FOUND");
    // Break: return ok with empty text — the agent cannot distinguish
    // "element exists but is empty" from "selector matched nothing".
  });

  it("flags truncated reads so the agent knows content was cut", async () => {
    const long = "x".repeat(5000);
    const out = await runReadPageDom(
      "s1",
      {},
      vi.fn().mockResolvedValue({ text: long, found: true }),
    );
    const body = JSON.parse(out.content[0]!.text) as { truncated: boolean };
    expect(body.truncated).toBe(true);
  });
});
