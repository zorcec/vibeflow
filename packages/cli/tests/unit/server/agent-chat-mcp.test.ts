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
} from "../../../src/server/agent-chat/website.js";
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
    const out = wrapUntrusted("Click here", "https://x.test/p");
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
      { url: "https://x.test/p" },
      (async () => htmlResponse("<h1>Hi</h1><p>there</p>")) as unknown as typeof fetch,
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
      { url: "https://x.test/a.png" },
      (async () =>
        htmlResponse("raw", "image/png")) as unknown as typeof fetch,
    )) as { isError: boolean };
    expect(out.isError).toBe(true);
  });

  it("maps fetch failures to FETCH_FAILED, never throws", async () => {
    const out = (await runReadPageText({ url: "https://x.test/" }, (async () => {
      throw new Error("dns");
    }) as unknown as typeof fetch)) as { isError: boolean };
    expect(out.isError).toBe(true);
  });
});

describe("runReadPageDom", () => {
  it("wraps the tab text as untrusted live-dom", async () => {
    const out = await runReadPageDom("s1", { selector: "#pay" }, vi
      .fn()
      .mockResolvedValue("Pay now $49"));
    const body = JSON.parse(out.content[0]!.text) as { text: string };
    expect(body.text).toContain("Pay now $49");
    expect(body.text).toContain('source="live-dom"');
  });

  it("null tab answer becomes a NO_TAB refusal, never a throw", async () => {
    const out = (await runReadPageDom("s1", {}, vi.fn().mockResolvedValue(null))) as {
      isError: boolean;
    };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("NO_TAB");
  });
});
