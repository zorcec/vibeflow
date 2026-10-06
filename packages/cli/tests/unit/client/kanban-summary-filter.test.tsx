// @vitest-environment jsdom
/**
 * Board-header task summary and the multi-tag filter.
 *
 * `buildTaskSummary` (App.tsx:449) is a pure function whose output string had
 * ZERO assertions anywhere, and `filteredTasks`' tag predicate
 * (`filterState.tags.every(...)` at App.tsx:1558) is an AND whose OR-swap is
 * invisible to every existing test. Both are asserted through the real `App`
 * here — the rendered header text and the rendered cards — because that is the
 * surface a user actually reads them from.
 */
import React, { act } from "react";
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { Task } from "@vibeflow-tools/ui/kanban";
import { App } from "../../../src/client/kanban/App.js";

// React 18 warns about state updates outside act() unless this is set.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

let serverTasks: Task[] = [];

function mockApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/tasks")) {
        return { ok: true, json: async () => ({ tasks: serverTasks }) };
      }
      // meta, settings, github-url, changelog — optional to the board.
      return { ok: true, json: async () => ({}) };
    }),
  );
}

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderApp() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  // Resolve the initial loadTasks() + optional metadata fetches.
  await flush();
  await flush();
}

function card(id: string): HTMLElement | null {
  return container.querySelector(`article[data-task-id="${id}"]`);
}

/** The one header line the summary renders into (`Header.tsx:202`). */
function taskSummary(): string {
  for (const p of Array.from(container.querySelectorAll("header p"))) {
    const text = p.textContent ?? "";
    if (/^\d+ (open|of) /.test(text)) return text;
  }
  throw new Error("board header did not render a task summary");
}

async function typeIntoSearch(value: string) {
  const input = container.querySelector(
    "#global-search",
  ) as HTMLInputElement | null;
  if (!input) throw new Error("global search input not found");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function filterBar(): HTMLElement {
  const bar = container.querySelector('[data-proto-id="filter-bar"]');
  if (!bar) throw new Error("filter bar not rendered");
  return bar as HTMLElement;
}

function findButton(root: HTMLElement, label: string): HTMLElement {
  const btn = Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent === label || b.textContent === `${label}✓`,
  );
  if (!btn) throw new Error(`button ${JSON.stringify(label)} not found`);
  return btn as HTMLElement;
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  document.body.className = "";
});

describe("board header task summary", () => {
  it("counts open / in-progress / review across the store", async () => {
    serverTasks = [
      { id: "t1", title: "Fix the bug", status: "review" },
      { id: "t2", title: "Write docs", status: "in-progress" },
      { id: "t3", title: "Ship it", status: "done" },
    ];
    mockApi();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    await renderApp();

    expect(taskSummary()).toContain("2 open · 1 in-progress · 1 in review");
  });

  it("reports 'N of M tasks' once a search is typed, case-insensitively", async () => {
    serverTasks = [
      { id: "t1", title: "Fix the bug", status: "review" },
      { id: "t2", title: "Write docs", status: "in-progress" },
      { id: "t3", title: "Ship it", status: "done" },
    ];
    mockApi();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    await renderApp();

    // UPPERCASE on purpose: the call site must lower-case the needle, or the
    // summary reads "0 of 3 tasks" for a title the user can see on screen.
    await typeIntoSearch("FIX");
    expect(taskSummary()).toContain("1 of 3 tasks");

    await typeIntoSearch("nothing-matches");
    expect(taskSummary()).toContain("0 of 3 tasks");

    await typeIntoSearch("");
    expect(taskSummary()).toContain("2 open · 1 in-progress · 1 in review");
  });
});

describe("multi-tag filter is an AND, not an OR", () => {
  it("keeps only the tasks carrying EVERY active tag", async () => {
    serverTasks = [
      {
        id: "a",
        title: "Both tags",
        status: "todo",
        tags: ["backend", "urgent"],
        updatedAt: "2026-01-03T00:00:00Z",
      },
      {
        id: "b",
        title: "One tag only",
        status: "todo",
        tags: ["urgent"],
        updatedAt: "2026-01-02T00:00:00Z",
      },
      {
        id: "c",
        title: "No tags",
        status: "todo",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    mockApi();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    await renderApp();

    // Control: nothing filtered yet, all three cards are on the board.
    expect(card("a")).not.toBeNull();
    expect(card("b")).not.toBeNull();
    expect(card("c")).not.toBeNull();

    await click(findButton(filterBar(), "Tags"));
    await click(findButton(filterBar(), "backend"));
    await click(findButton(filterBar(), "urgent"));

    expect(card("a")).not.toBeNull();
    // `tags.every(...)` → `some` would leave b (and only b's "urgent") on the
    // board — a silent AND→OR inversion of the filter.
    expect(card("b")).toBeNull();
    expect(card("c")).toBeNull();
  });
});
