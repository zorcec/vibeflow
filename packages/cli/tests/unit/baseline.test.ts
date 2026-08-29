import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock browser globals before importing the module ──────────────────────────

const mockGetComputedStyle = vi.fn();
const mockDocumentCookie = "";

function setupBrowserMocks() {
  // Mock document
  vi.stubGlobal("document", {
    body: { outerHTML: "<body></body>" },
    documentElement: { outerHTML: "<html></html>" },
    cookie: mockDocumentCookie,
    createElement: vi.fn((tag: string) => ({ tagName: tag.toUpperCase(), className: "" })),
    querySelector: vi.fn(),
  });

  // Mock window
  vi.stubGlobal("window", {
    scrollX: 0,
    scrollY: 100,
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 2,
    getComputedStyle: mockGetComputedStyle,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    confirm: vi.fn(() => true),
  });

  // Mock navigator
  vi.stubGlobal("navigator", {
    userAgent: "TestBrowser/1.0",
  });

  // Mock history
  vi.stubGlobal("history", {
    pushState: vi.fn(),
    replaceState: vi.fn(),
  });

  // Mock crypto
  vi.stubGlobal("crypto", {
    subtle: {
      importKey: vi.fn(),
      deriveKey: vi.fn(),
      encrypt: vi.fn(),
      decrypt: vi.fn(),
    },
    getRandomValues: vi.fn((arr: Uint8Array) => arr),
  });

  // Mock fetch
  vi.stubGlobal("fetch", vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }),
  ));

  // Mock localStorage
  const lsStore: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => lsStore[key] ?? null),
    setItem: vi.fn((key: string, val: string) => { lsStore[key] = val; }),
    removeItem: vi.fn((key: string) => { delete lsStore[key]; }),
    key: vi.fn((i: number) => Object.keys(lsStore)[i] ?? null),
    length: 0,
  });

  // Mock sessionStorage
  vi.stubGlobal("sessionStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    key: vi.fn(() => null),
    length: 0,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("baseline capture", () => {
  beforeEach(() => {
    setupBrowserMocks();
    mockGetComputedStyle.mockReturnValue({
      getPropertyValue: vi.fn((prop: string) => {
        const styles: Record<string, string> = {
          display: "block",
          position: "static",
          visibility: "visible",
          "font-size": "16px",
          "z-index": "auto",
          opacity: "1",
        };
        return styles[prop] ?? "";
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captureDomSnapshot captures outerHTML", async () => {
    const { captureDomSnapshot } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      outerHTML: '<div class="test">Hello</div>',
      getBoundingClientRect: () => ({
        x: 100, y: 200, width: 300, height: 50,
        top: 200, right: 400, bottom: 250, left: 100, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const snapshot = captureDomSnapshot(el, ".test", []);
    expect(snapshot.outerHTML).toBe('<div class="test">Hello</div>');
  });

  it("captureDomSnapshot captures selector", async () => {
    const { captureDomSnapshot } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      outerHTML: "<div></div>",
      getBoundingClientRect: () => ({
        x: 0, y: 0, width: 100, height: 100,
        top: 0, right: 100, bottom: 100, left: 0, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const snapshot = captureDomSnapshot(el, "#app > button", []);
    expect(snapshot.selector).toBe("#app > button");
  });

  it("captureDomSnapshot captures console errors", async () => {
    const { captureDomSnapshot } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      outerHTML: "<div></div>",
      getBoundingClientRect: () => ({
        x: 0, y: 0, width: 100, height: 100,
        top: 0, right: 100, bottom: 100, left: 0, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const errors = ["TypeError: foo", "ReferenceError: bar"];
    const snapshot = captureDomSnapshot(el, ".test", errors);
    expect(snapshot.consoleErrors).toEqual(errors);
  });

  it("captureDomSnapshot captures browser string", async () => {
    const { captureDomSnapshot } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      outerHTML: "<div></div>",
      getBoundingClientRect: () => ({
        x: 0, y: 0, width: 100, height: 100,
        top: 0, right: 100, bottom: 100, left: 0, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const snapshot = captureDomSnapshot(el, ".test", []);
    expect(snapshot.browser).toBe("TestBrowser/1.0");
  });

  it("captureDomSnapshot captures capturedAt timestamp", async () => {
    const { captureDomSnapshot } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      outerHTML: "<div></div>",
      getBoundingClientRect: () => ({
        x: 0, y: 0, width: 100, height: 100,
        top: 0, right: 100, bottom: 100, left: 0, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const before = new Date().toISOString();
    const snapshot = captureDomSnapshot(el, ".test", []);
    const after = new Date().toISOString();
    expect(snapshot.capturedAt >= before).toBe(true);
    expect(snapshot.capturedAt <= after).toBe(true);
  });

  it("captureDomSnapshot captures computed styles", async () => {
    const { captureDomSnapshot } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      outerHTML: "<div></div>",
      getBoundingClientRect: () => ({
        x: 0, y: 0, width: 100, height: 100,
        top: 0, right: 100, bottom: 100, left: 0, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const snapshot = captureDomSnapshot(el, ".test", []);
    expect(snapshot.computedStyles).toHaveProperty("display");
    expect(snapshot.computedStyles).toHaveProperty("position");
  });

  it("captureDomSnapshot captures position context", async () => {
    const { captureDomSnapshot } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      outerHTML: "<div></div>",
      getBoundingClientRect: () => ({
        x: 100, y: 200, width: 300, height: 50,
        top: 200, right: 400, bottom: 250, left: 100, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const snapshot = captureDomSnapshot(el, ".test", []);
    expect(snapshot.position).toBeDefined();
    expect(snapshot.position.boundingBox).toEqual({
      x: 100, y: 200, width: 300, height: 50,
    });
  });

  it("captureDomSnapshot captures xpath", async () => {
    const { captureDomSnapshot } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      outerHTML: "<div></div>",
      getBoundingClientRect: () => ({
        x: 0, y: 0, width: 100, height: 100,
        top: 0, right: 100, bottom: 100, left: 0, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const snapshot = captureDomSnapshot(el, ".test", []);
    expect(snapshot.xpath).toBeDefined();
    expect(typeof snapshot.xpath).toBe("string");
  });
});

describe("capturePositionContext", () => {
  beforeEach(() => {
    setupBrowserMocks();
    mockGetComputedStyle.mockReturnValue({
      position: "relative",
      zIndex: "10",
      getPropertyValue: vi.fn((prop: string) => {
        if (prop === "position") return "relative";
        if (prop === "z-index") return "10";
        return "";
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures bounding box from getBoundingClientRect", async () => {
    const { capturePositionContext } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      getBoundingClientRect: () => ({
        x: 100, y: 200, width: 300, height: 50,
        top: 200, right: 400, bottom: 250, left: 100, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const ctx = capturePositionContext(el);
    expect(ctx.boundingBox).toEqual({
      x: 100, y: 200, width: 300, height: 50,
    });
  });

  it("captures scroll position", async () => {
    const { capturePositionContext } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      getBoundingClientRect: () => ({
        x: 0, y: 0, width: 100, height: 100,
        top: 0, right: 100, bottom: 100, left: 0, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const ctx = capturePositionContext(el);
    expect(ctx.scrollPosition).toEqual({ x: 0, y: 100 });
  });

  it("captures viewport dimensions", async () => {
    const { capturePositionContext } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      getBoundingClientRect: () => ({
        x: 0, y: 0, width: 100, height: 100,
        top: 0, right: 100, bottom: 100, left: 0, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const ctx = capturePositionContext(el);
    expect(ctx.viewport).toEqual({
      width: 1920,
      height: 1080,
      dpr: 2,
    });
  });

  it("captures stacking context", async () => {
    const { capturePositionContext } = await import("../../src/client/overlay-browser/core/baseline.js");

    const el = {
      getBoundingClientRect: () => ({
        x: 0, y: 0, width: 100, height: 100,
        top: 0, right: 100, bottom: 100, left: 0, toJSON: vi.fn(),
      }),
      parentElement: null,
      tagName: "DIV",
    } as unknown as HTMLElement;

    const ctx = capturePositionContext(el);
    expect(ctx.stackingContext.position).toBe("relative");
    expect(ctx.stackingContext.zIndex).toBe("10");
  });
});
