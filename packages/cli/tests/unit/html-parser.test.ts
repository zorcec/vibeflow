import { describe, it, expect } from "vitest";
import {
  extractProtoIds,
  injectScript,
  hasExternalDependencies,
  isValidHtml,
  getElementContent,
} from "../../src/core/html-parser.js";

describe("extractProtoIds", () => {
  it("extracts all data-vibeflow-id attributes", () => {
    const html = `<div data-vibeflow-id="section-1">
  <button data-vibeflow-id="btn-submit">Go</button>
  <nav data-vibeflow-id="main-nav">Links</nav>
</div>`;

    const ids = extractProtoIds(html);
    expect(ids).toEqual(["section-1", "btn-submit", "main-nav"]);
  });

  it("returns empty array when no ids present", () => {
    const html = `<div class="test"><p>Hello</p></div>`;
    expect(extractProtoIds(html)).toEqual([]);
  });

  it("handles nested elements correctly", () => {
    const html = `<div data-vibeflow-id="outer">
  <div data-vibeflow-id="inner">
    <span data-vibeflow-id="deep">Text</span>
  </div>
</div>`;

    const ids = extractProtoIds(html);
    expect(ids).toHaveLength(3);
    expect(ids).toContain("outer");
    expect(ids).toContain("inner");
    expect(ids).toContain("deep");
  });

  it("handles full HTML document", () => {
    const html = `<!DOCTYPE html><html><head><title>Test</title></head>
<body><div data-vibeflow-id="root">Content</div></body></html>`;

    expect(extractProtoIds(html)).toEqual(["root"]);
  });
});

describe("injectScript", () => {
  it("injects script before closing body tag", () => {
    const html = `<html><body><div>content</div></body></html>`;
    const result = injectScript(html, "console.log('hello')");

    expect(result).toContain("<script data-vibeflow-overlay>");
    expect(result).toContain("console.log('hello')");
    const scriptIdx = result.indexOf("<script data-vibeflow-overlay>");
    const bodyCloseIdx = result.indexOf("</body>");
    expect(scriptIdx).toBeLessThan(bodyCloseIdx);
  });

  it("appends script when no body tag found", () => {
    const html = `<div>No body tag</div>`;
    const result = injectScript(html, "alert(1)");

    expect(result).toContain("alert(1)");
    expect(result).toContain("<script data-vibeflow-overlay>");
  });

  it("preserves existing content", () => {
    const html = `<html><body><h1>Hello World</h1></body></html>`;
    const result = injectScript(html, "void 0");

    expect(result).toContain("<h1>Hello World</h1>");
  });
});

describe("hasExternalDependencies", () => {
  it("detects external scripts", () => {
    const html = `<html><head>
  <script src="https://cdn.example.com/lib.js"></script>
</head><body></body></html>`;

    const externals = hasExternalDependencies(html);
    expect(externals).toHaveLength(1);
    expect(externals[0]).toContain("https://cdn.example.com/lib.js");
  });

  it("detects external stylesheets", () => {
    const html = `<html><head>
  <link rel="stylesheet" href="https://example.com/style.css">
</head><body></body></html>`;

    const externals = hasExternalDependencies(html);
    expect(externals).toHaveLength(1);
    expect(externals[0]).toContain("style.css");
  });

  it("ignores inline scripts", () => {
    const html = `<html><body><script>console.log('hi')</script></body></html>`;
    expect(hasExternalDependencies(html)).toEqual([]);
  });

  it("ignores relative paths", () => {
    const html = `<html><head>
  <script src="./local.js"></script>
  <link rel="stylesheet" href="style.css">
</head><body></body></html>`;

    expect(hasExternalDependencies(html)).toEqual([]);
  });

  it("returns empty array for clean HTML", () => {
    const html = `<!DOCTYPE html><html><head><style>body{color:red}</style></head>
<body><div>Hello</div></body></html>`;

    expect(hasExternalDependencies(html)).toEqual([]);
  });
});

describe("isValidHtml", () => {
  it("returns true for valid HTML", () => {
    expect(
      isValidHtml("<!DOCTYPE html><html><body>Hello</body></html>"),
    ).toBe(true);
  });

  it("returns true for HTML fragment", () => {
    expect(isValidHtml("<div>Hello</div>")).toBe(true);
  });

  it("returns true for non-empty text", () => {
    expect(isValidHtml("Just text")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isValidHtml("")).toBe(false);
  });

  it("returns false for whitespace-only", () => {
    expect(isValidHtml("   \n  ")).toBe(false);
  });
});

describe("getElementContent", () => {
  it("returns outer HTML of targeted element", () => {
    const html = `<div data-vibeflow-id="card-1"><h2>Title</h2><p>Body</p></div>`;
    const content = getElementContent(html, "card-1");
    expect(content).toContain("card-1");
    expect(content).toContain("<h2>Title</h2>");
    expect(content).toContain("<p>Body</p>");
  });

  it("returns null for non-existent proto-id", () => {
    const html = `<div data-vibeflow-id="card-1">Content</div>`;
    expect(getElementContent(html, "nonexistent")).toBeNull();
  });

  it("handles nested proto-id elements", () => {
    const html = `<div data-vibeflow-id="outer">
  <span data-vibeflow-id="inner">Text</span>
</div>`;
    const content = getElementContent(html, "inner");
    expect(content).toContain("inner");
    expect(content).toContain("Text");
  });
});
