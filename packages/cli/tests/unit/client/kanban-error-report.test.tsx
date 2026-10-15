// @vitest-environment jsdom
/**
 * Browser-side kanban error reporting (ticket 5087f5e3).
 *
 * - `installKanbanErrorReporting()` forwards window `error` and
 *   `unhandledrejection` to POST /api/client-error (the server enforces
 *   the telemetry flag — the client always attempts the POST).
 * - Client-side dedupe + cap mirror the server.
 * - `KanbanErrorBoundary` reports a render crash and paints a usable
 *   fallback instead of a blank board.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import {
  installKanbanErrorReporting,
  resetKanbanErrorReportingForTests,
} from "../../../src/client/kanban/error-report.js";
import { KanbanErrorBoundary } from "../../../src/client/kanban/error-boundary.js";

let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(): void {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
}

function postedBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map(
    ([_url, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
  );
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  stubFetch();
  resetKanbanErrorReportingForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("installKanbanErrorReporting", () => {
  it("forwards a window error to /api/client-error", async () => {
    installKanbanErrorReporting();
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new TypeError("boom happened"),
        message: "boom happened",
      }),
    );
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/client-error");
    expect((init.method ?? "")).toBe("POST");
    expect(postedBodies()[0]).toMatchObject({
      name: "TypeError",
      message: "boom happened",
    });
  });

  it("dedupes identical errors and still sends distinct ones", async () => {
    installKanbanErrorReporting();
    const err = (message: string): ErrorEvent =>
      new ErrorEvent("error", { error: new Error(message), message });
    window.dispatchEvent(err("same crash"));
    window.dispatchEvent(err("same crash"));
    window.dispatchEvent(err("different crash"));
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postedBodies().map((b) => b.message)).toEqual([
      "same crash",
      "different crash",
    ]);
  });

  it("forwards unhandled rejections without touching the console", async () => {
    installKanbanErrorReporting();
    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), {
        reason: new Error("stray rejection"),
      }),
    );
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedBodies()[0]).toMatchObject({ message: "stray rejection" });
  });

  it("installs once — a second call adds no second listener", async () => {
    installKanbanErrorReporting();
    installKanbanErrorReporting();
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("once"), message: "once" }),
    );
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("KanbanErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
  });

  it("reports a render crash and renders a usable fallback", async () => {
    function Thrower(): React.ReactNode {
      throw new Error("render exploded");
    }
    // React logs the caught error — silence it for a clean suite output.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      root = createRoot(container);
      await act(async () => {
        root!.render(
          <KanbanErrorBoundary>
            <Thrower />
          </KanbanErrorBoundary>,
        );
      });
      const fallback = container.querySelector(
        '[data-role="kanban-error-fallback"]',
      );
      expect(fallback).not.toBeNull();
      expect(fallback!.textContent).toContain("Something went wrong");
      expect(fallback!.textContent).toContain("Try again");
      expect(fallback!.textContent).toContain("Reload board");
      await tick();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(postedBodies()[0]).toMatchObject({ message: "render exploded" });
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
