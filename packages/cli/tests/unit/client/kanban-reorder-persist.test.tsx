// @vitest-environment jsdom
/**
 * Regression: a main-board card drag must persist the `computeReorder`
 * normalization patches, not just the dragged task's sortKey.
 *
 * `compareTaskOrder` sorts any keyed task before every keyless one, so on a
 * board full of keyless tasks (the common legacy case) writing only the
 * dragged key silently discards the drop position: on the next read the
 * dragged card jumps to the top of the column. This test drives the real
 * `App` through a drag, replays the PATCHes it issued into an in-memory
 * "server", then re-sorts that server truth with `compareTaskOrder` — the
 * reload path the user actually sees. It fails when only the dragged task is
 * persisted (pre-fix) and passes once the patches are written too.
 */
import React, { act } from "react";
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { compareTaskOrder } from "@vibeflow-tools/ui/kanban";
import type { Task } from "@vibeflow-tools/ui/kanban";
import { App } from "../../../src/client/kanban/App.js";

// React 18 warns about state updates outside act() unless this is set.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  // Deterministic 40px-tall card rects → the card drop band clamps to 32px, so
  // clientY 39 lands in the bottom ("after") band and clientY 1 in the top one.
  Element.prototype.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 40,
      left: 0,
      right: 200,
      width: 200,
      height: 40,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

/** jsdom has no DragEvent; a bubbling MouseEvent carries clientY for dragover
 *  and a plain Event accepts an assigned dataTransfer for dragstart. */
function dispatchDrag(
  el: Element,
  type: string,
  props: Record<string, unknown> = {},
) {
  const { clientY, ...rest } = props as { clientY?: number };
  const ev =
    typeof clientY === "number"
      ? new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
      : new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, rest);
  el.dispatchEvent(ev);
}

function dataTransfer() {
  return { setData: vi.fn(), getData: vi.fn(() => ""), effectAllowed: "none" };
}

function makeTask(id: string, updatedAt: string): Task {
  // No sortKey — the exact legacy state the user's store is in.
  return { id, title: id.toUpperCase(), status: "todo", updatedAt };
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

/** In-memory server truth. PATCHes the App issues are replayed onto it, so a
 *  re-sort here is the persisted order after a reload. */
let serverTasks: Task[] = [];

function mockApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PATCH" && url.includes("/api/tasks/")) {
        const id = decodeURIComponent(
          url.split("/api/tasks/")[1].split("?")[0],
        );
        const body = JSON.parse(String(init?.body ?? "{}")) as Partial<Task>;
        const task = serverTasks.find((t) => t.id === id);
        if (task) Object.assign(task, body);
        return jsonResponse({ success: true, task });
      }
      if (url.includes("/api/tasks")) {
        return jsonResponse({ tasks: serverTasks });
      }
      // Every other endpoint (meta, settings, github-url, changelog) is
      // optional to the board — an empty payload leaves the defaults standing.
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
  // Resolve the initial loadTasks() + optional metadata fetches.
  await flush();
  await flush();
}

function card(id: string): HTMLElement | null {
  return container.querySelector(`article[data-task-id="${id}"]`);
}

function mustCard(id: string): HTMLElement {
  const el = card(id);
  if (!el) throw new Error(`card ${id} not rendered`);
  return el;
}

describe("Kanban card reorder persists normalization patches", () => {
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    document.body.className = "";
  });

  it("a card dropped after two keyless siblings keeps its position after a reload-style re-sort", async () => {
    serverTasks = [
      makeTask("a", "2026-01-01T00:00:00Z"),
      makeTask("b", "2026-01-02T00:00:00Z"),
      makeTask("c", "2026-01-03T00:00:00Z"),
    ];
    mockApi();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    await renderApp();

    // Keyless tasks render oldest-first: A, B, C.
    expect(card("a")).not.toBeNull();
    expect(card("b")).not.toBeNull();
    expect(card("c")).not.toBeNull();

    // Drag A onto C's bottom edge → "drop after C".
    const wrapperC = mustCard("c").parentElement as HTMLElement;
    const column = container.querySelector(
      '[data-column-id="todo"]',
    ) as HTMLElement;
    await act(async () => {
      dispatchDrag(mustCard("a"), "dragstart", { dataTransfer: dataTransfer() });
    });
    await act(async () => {
      dispatchDrag(wrapperC, "dragover", { clientY: 39 });
    });
    await act(async () => {
      dispatchDrag(column, "drop");
    });
    await flush();
    await flush();

    // What the user sees after the next read: re-sort persisted server truth.
    const persisted = serverTasks
      .filter((t) => t.status === "todo")
      .sort(compareTaskOrder)
      .map((t) => t.id);
    expect(persisted).toEqual(["b", "c", "a"]);
  });
});
