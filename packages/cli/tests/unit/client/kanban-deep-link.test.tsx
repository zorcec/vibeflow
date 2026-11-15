// @vitest-environment jsdom
/**
 * Path-based task deep links: `/kanban/<task-id>[/<tab>]`.
 *
 * Drives the real `App` under a deep-link URL (set via replaceState, which
 * jsdom supports) and asserts the detail panel opens on the requested tab.
 * The server route serving the same HTML for those paths is covered by
 * tests/unit/server/kanban-deep-link.test.ts; the pure parse/build helpers
 * by tests/unit/kanban-deep-link.test.ts.
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

const ID = "d89a3009abf34626c7f31f14ea08a0";
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let serverTasks: Task[] = [];

function mockApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/tasks")) {
        if (url.endsWith("/comments")) return jsonResponse({ comments: [] });
        if (url.endsWith("/files")) return jsonResponse({ files: [] });
        return jsonResponse({ tasks: serverTasks });
      }
      return jsonResponse({});
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
  await flush();
  await flush();
  await flush();
}

function activeTab(): string | null {
  return (
    container.querySelector("#dp-tabs-row .dp-tab.active")?.id ?? null
  );
}

describe("kanban task deep links", () => {
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    document.body.className = "";
    window.history.replaceState(null, "", "/kanban");
  });

  it("/kanban/<id>/activity opens the task on the Activity tab", async () => {
    serverTasks = [{ id: ID, title: "Deep", status: "todo" }];
    mockApi();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    window.history.replaceState(null, "", `/kanban/${ID}/activity`);
    await renderApp();

    // The detail panel opened on the comments (= Activity) tab.
    expect(activeTab()).toBe("dp-tab-activity");
    const pane = container.querySelector("#dp-activity-pane") as HTMLElement;
    expect(pane.style.display).toBe("");
  });

  it("/kanban/<id> opens the task on the Details tab", async () => {
    serverTasks = [{ id: ID, title: "Deep", status: "todo" }];
    mockApi();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    window.history.replaceState(null, "", `/kanban/${ID}`);
    await renderApp();

    expect(activeTab()).toBe("dp-tab-details");
  });

  it("/kanban/<id>/files opens the task on the Files tab", async () => {
    serverTasks = [{ id: ID, title: "Deep", status: "todo" }];
    mockApi();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    window.history.replaceState(null, "", `/kanban/${ID}/files`);
    await renderApp();

    expect(activeTab()).toBe("dp-tab-files");
  });

  it("an unknown task id renders the plain board (no panel)", async () => {
    serverTasks = [{ id: ID, title: "Deep", status: "todo" }];
    mockApi();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    window.history.replaceState(null, "", `/kanban/${OTHER}/activity`);
    await renderApp();

    expect(container.querySelector("#dp-tabs-row .dp-tab.active")).toBeNull();
    expect(window.location.pathname).toBe(`/kanban/${OTHER}/activity`);
  });

  it("browser Back to the plain board closes the panel", async () => {
    serverTasks = [{ id: ID, title: "Deep", status: "todo" }];
    mockApi();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    window.history.replaceState(null, "", `/kanban/${ID}/activity`);
    await renderApp();
    expect(activeTab()).toBe("dp-tab-activity");

    // Back navigation to the board URL: the panel closes.
    window.history.replaceState(null, "", "/kanban");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();

    expect(container.querySelector("#dp-tabs-row .dp-tab.active")).toBeNull();
  });
});
