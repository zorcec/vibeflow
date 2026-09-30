/**
 * The ONE guide builder.
 *
 * These pin the contract the rest of the codebase reads: the console banners,
 * the `/inject` page and the two MCP tools must never disagree about a URL or
 * a snippet. The banner lines are asserted against the EXACT strings the CLI
 * printed before the extraction — that equality is the reason the refactor was
 * safe, so it is worth a test rather than a comment.
 */
import { describe, it, expect } from "vitest";
import chalk from "chalk";
import {
  buildBoardsAndApisLines,
  buildBookmarkletLines,
  buildGuideText,
  buildIntegrateIntoAppLines,
  buildIntegrationGuide,
  buildKanbanReadyLines,
  buildOnlineAddToHtmlLines,
  guideDivider,
  localhostAltLine,
  localhostScriptTagAltLine,
  overlayScriptTag,
  resolveDisplayUrl,
} from "../../../src/server/startup-guide.js";

// The exact-string assertions below hold because chalk emits no escapes when
// stdout is not a TTY, which it is not under vitest. A guard test below asserts
// that directly, so a TTY-runner regression fails loudly and legibly rather
// than as a wall of unreadable escape codes.

const LOCAL = resolveDisplayUrl("localhost", 3700);
const DUAL = resolveDisplayUrl("0.0.0.0", 3700);

describe("resolveDisplayUrl — the one host→URL rule", () => {
  it("runs with colour disabled, so the exact-string assertions below are exact", () => {
    // Guards the premise of every `toEqual([...])` in this file. If this ever
    // fails, chalk is emitting escapes into a non-TTY run and the expected
    // strings below would need stripping rather than hand-editing.
    expect(chalk.level).toBe(0);
  });

  it("localhost has no twin", () => {
    expect(LOCAL).toEqual({ url: "http://localhost:3700", localUrl: null });
  });

  it("0.0.0.0 always gets a localhost twin (the dual-URL rule)", () => {
    expect(DUAL.localUrl).toBe("http://localhost:3700");
    // A LAN IPv4, not a loopback — the whole point of the 0.0.0.0 rule.
    expect(DUAL.url).toMatch(/^http:\/\/[^:]+:3700$/);
    expect(DUAL.url).not.toContain("localhost");
  });

  it("a named host is used verbatim", () => {
    expect(resolveDisplayUrl("example.test", 8080)).toEqual({
      url: "http://example.test:8080",
      localUrl: null,
    });
  });
});

describe("buildIntegrationGuide — the URL/snippet source of truth", () => {
  it("derives every URL from the base", () => {
    const g = buildIntegrationGuide(LOCAL);
    expect(g.kanbanUrl).toBe("http://localhost:3700/kanban");
    expect(g.taskApiUrl).toBe("http://localhost:3700/api/tasks");
    expect(g.injectUrl).toBe("http://localhost:3700/inject");
    expect(g.overlayScriptUrl).toBe(
      "http://localhost:3700/vibeflow-overlay.js",
    );
  });

  it("adds a localhost twin only when bound to 0.0.0.0", () => {
    expect(buildIntegrationGuide(LOCAL).scriptTagLocal).toBeNull();
    expect(buildIntegrationGuide(DUAL).scriptTagLocal).toBe(
      `<script src="http://localhost:3700/vibeflow-overlay.js" data-vibeflow-overlay></script>`,
    );
  });

  it("online mode points at the SaaS overlay and uses the CSP-safe snippet", () => {
    const g = buildIntegrationGuide(LOCAL, {
      online: true,
      overlayBaseUrl: "https://app.vibeflow.tools",
      boardId: "bid1",
    });
    expect(g.overlayScriptUrl).toBe(
      "https://app.vibeflow.tools/api/overlay.js",
    );
    expect(g.consoleSnippet).toBe(
      "window.__PROTO_BOARD_ID='bid1';fetch('https://app.vibeflow.tools/api/overlay.js').then(r=>r.text()).then(code=>eval(code));",
    );
    expect(g.bookmarkletCode).toContain("fetch('https://app.vibeflow.tools/api/overlay.js')");
  });

  it("offline mode uses the script-tag snippet", () => {
    const g = buildIntegrationGuide(LOCAL);
    expect(g.consoleSnippet).toContain("document.head.appendChild(s);");
    expect(g.consoleSnippet).not.toContain("eval(code)");
  });

  it("an explicit overlayBaseUrl suppresses the dual-URL twin", () => {
    // /inject's local page links `http://localhost:<port>` even on a 0.0.0.0
    // bind, so there is nothing to twin.
    const g = buildIntegrationGuide(DUAL, {
      overlayBaseUrl: "http://localhost:3700",
    });
    expect(g.overlayScriptUrl).toBe("http://localhost:3700/vibeflow-overlay.js");
    expect(g.localOverlayScriptUrl).toBeNull();
  });

  it("boardId is carried into the script tag and the snippets", () => {
    const g = buildIntegrationGuide(LOCAL, { boardId: "abc" });
    expect(g.scriptTag).toContain('data-board-id="abc"');
    expect(g.consoleSnippet).toContain("s.setAttribute('data-board-id','abc');");
  });
});

describe("overlayScriptTag", () => {
  it("omits the board attribute when there is no board", () => {
    expect(overlayScriptTag("http://x/y.js")).toBe(
      `<script src="http://x/y.js" data-vibeflow-overlay></script>`,
    );
  });
});

describe("banner lines are byte-identical to the pre-extraction output", () => {
  it("BOARDS & APIS", () => {
    expect(buildBoardsAndApisLines(buildIntegrationGuide(LOCAL))).toEqual([
      "  BOARDS & APIS",
      "  Kanban board    http://localhost:3700/kanban",
      "  Task API        http://localhost:3700/api/tasks",
    ]);
  });

  it("BOARDS & APIS gains a localhost continuation when dual-bound", () => {
    expect(buildBoardsAndApisLines(buildIntegrationGuide(DUAL))).toEqual([
      "  BOARDS & APIS",
      "  Kanban board    " + DUAL.url + "/kanban",
      (localhostAltLine(DUAL.localUrl, "/kanban", 18)),
      "  Task API        " + DUAL.url + "/api/tasks",
      (localhostAltLine(DUAL.localUrl, "/api/tasks", 18)),
    ]);
  });

  it("INTEGRATE INTO YOUR APP — the section both serve() paths print", () => {
    expect(buildIntegrateIntoAppLines(buildIntegrationGuide(LOCAL))).toEqual([
      guideDivider(),
      "  INTEGRATE INTO YOUR APP  (full guide: http://localhost:3700/inject)",
      "  1. Add this script tag to your HTML:",
      '     <script src="http://localhost:3700/vibeflow-overlay.js" data-vibeflow-overlay></script>',
      "  2. Reload your page — the overlay appears automatically.",
      "  3. Click anything to annotate it.",
    ]);
  });

  it("INTEGRATE INTO YOUR APP — dual-bound adds both alt lines", () => {
    const lines = buildIntegrateIntoAppLines(buildIntegrationGuide(DUAL));
    expect(lines).toHaveLength(8);
    expect(lines[2]).toBe((localhostAltLine(DUAL.localUrl, "/inject", 40)));
    expect(lines[5]).toBe((localhostScriptTagAltLine(DUAL.localUrl, 5)));
  });

  it("bookmarklet block", () => {
    expect(buildBookmarkletLines(buildIntegrationGuide(LOCAL))).toEqual([
      guideDivider(),
      "  Bookmarklet — no code changes needed:",
      "  Visit and drag the bookmarklet from http://localhost:3700/inject to your bookmarks bar.",
    ]);
  });

  it("online add-to-your-app box", () => {
    const lines = buildOnlineAddToHtmlLines(buildIntegrationGuide(DUAL));
    expect(lines[0]).toBe("  ┌─ Add to your HTML " + "─".repeat(43) + "┐");
    expect(lines[1]).toBe(
      `  │ <script src="${DUAL.url}/vibeflow-overlay.js" data-vibeflow-overlay></script> │`,
    );
    expect(lines[2]).toBe(
      `  │ or: <script src="http://localhost:3700/vibeflow-overlay.js" data-vibeflow-overlay></script> │`,
    );
    expect(lines[lines.length - 1]).toBe("  └" + "─".repeat(63) + "┘");
  });

  it("kanban-ready block — what `vibeflow kanban` prints and start_kanban returns", () => {
    expect(buildKanbanReadyLines(buildIntegrationGuide(LOCAL))).toEqual([
      "",
      "  ✓ Kanban board ready",
      "    http://localhost:3700/kanban",
      "",
      "Agent prompt:",
      "  Get new tasks and implement them, once done check again for new ones:",
      "  npx @vibeflow-tools/cli tasks --next",
      "",
      "  Press Ctrl+C to stop",
      "",
    ]);
  });

  it("kanban-ready block prints the localhost twin when dual-bound", () => {
    const lines = buildKanbanReadyLines(buildIntegrationGuide(DUAL));
    expect(lines[3]).toBe("    http://localhost:3700/kanban");
  });
});

describe("buildGuideText — the ANSI-free MCP payload", () => {
  it("carries no terminal escapes", () => {
    // eslint-disable-next-line no-control-regex -- deliberately matching ESC
    expect(buildGuideText(buildIntegrationGuide(LOCAL))).not.toMatch(/\u001b\[/);
  });

  it("names the kanban URL, the script tag and the agent prompt", () => {
    const text = buildGuideText(buildIntegrationGuide(LOCAL));
    expect(text).toContain("Kanban board: http://localhost:3700/kanban");
    expect(text).toContain(
      `<script src="http://localhost:3700/vibeflow-overlay.js" data-vibeflow-overlay></script>`,
    );
    expect(text).toContain("npx @vibeflow-tools/cli tasks --next");
  });

  it("says the server is NOT running, and names start_kanban, when it is not", () => {
    const text = buildGuideText(buildIntegrationGuide(LOCAL), {
      serverRunning: false,
    });
    expect(text).toContain("NOT running");
    expect(text).toContain("start_kanban");
  });

  it("omits the not-running signal when the server IS up", () => {
    const text = buildGuideText(buildIntegrationGuide(LOCAL), {
      serverRunning: true,
    });
    expect(text).not.toContain("NOT running");
  });
});
