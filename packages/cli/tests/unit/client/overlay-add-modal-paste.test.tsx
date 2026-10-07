// @vitest-environment jsdom
/**
 * Overlay add-task modal: paste-to-attach wiring.
 *
 * Drives the real `OverlayApp` + `OverlayAddModal` (the floating task-creation
 * modal shipped in vibeflow-overlay.js) in jsdom:
 *  - pasting an image into any modal field buffers a quiet thumbnail chip
 *    (32px preview, filename, × to remove);
 *  - plain-text paste in the description field is never intercepted;
 *  - saving uploads the buffered file with the kanban octet-stream contract
 *    and passes the form payload through to the submit handler.
 *
 * jsdom has no canvas/image pipeline, so image compression deterministically
 * falls back to the raw blob (unit-proven in overlay-paste.test.ts); the
 * thumbnail URL is stubbed to prove the <img> chip path.
 */
import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import {
  OverlayApp,
  showOverlayAddModal,
} from "../../../src/client/overlay-react/OverlayApp.js";

// React 18 warns about state updates outside act() unless this is set.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PNG_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
  120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 160, 90, 186, 57, 0, 0, 0, 0,
  73, 69, 78, 68, 174, 66, 96, 130,
]);
const API = "http://localhost:9/api/tasks";

function imageClipboardData(name = "clipboard.png") {
  const file = new File([PNG_BYTES], name, { type: "image/png" });
  return {
    items: [
      {
        kind: "file",
        type: "image/png",
        getAsFile: () => file,
      },
    ],
  };
}

function textClipboardData() {
  return {
    items: [
      {
        kind: "string",
        type: "text/plain",
        getAsFile: () => null,
      },
    ],
  };
}

/** Paste must bubble from the field to the dialog listener, like a real keypress. */
function dispatchPaste(target: Element, clipboardData: unknown): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  (event as unknown as Record<string, unknown>).clipboardData = clipboardData;
  target.dispatchEvent(event);
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("OverlayAddModal paste-to-attach", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchCalls: Array<{ url: string; init: RequestInit }>;
  let onSubmitTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("PROTO_CONFIG", { apiUrl: API });
    // jsdom has no canvas/image pipeline: thumbnails are stubbed, and the
    // mock Image fails every load so compression deterministically falls back
    // to the raw blob (the success path runs in real Chromium, covered by
    // the Playwright spec asserting JPEG bytes on the task).
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(
      () => "blob:mock-thumb",
    );
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 0;
      naturalHeight = 0;
      set src(_value: string) {
        setTimeout(() => this.onerror?.(), 0);
      }
    }
    vi.stubGlobal("Image", FailingImage);
    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init });
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );
    onSubmitTask = vi.fn(async () => ({
      success: true,
      taskId: "task-1",
      taskAuthor: "tester",
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(OverlayApp, {
          onOpenKanban: () => {},
          onSubmitTask,
        }),
      );
    });
    act(() => {
      showOverlayAddModal({});
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function modal(): HTMLElement {
    const dialog = container.querySelector(
      ".overlay-add-modal",
    ) as HTMLElement | null;
    expect(dialog).not.toBeNull();
    return dialog as HTMLElement;
  }

  function chips(): NodeListOf<Element> {
    return modal().querySelectorAll(".vibeflow-paste-chip");
  }

  it("buffers a pasted image as a thumbnail chip with filename", async () => {
    const textarea = modal().querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    dispatchPaste(textarea, imageClipboardData());
    await flushAsync();

    expect(chips()).toHaveLength(1);
    const name = modal().querySelector(".vibeflow-paste-name")?.textContent;
    expect(name).toMatch(/^paste-.*\.png$/);
    const img = modal().querySelector(
      ".vibeflow-paste-chip img",
    ) as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("blob:mock-thumb");
  });

  it("ignores plain-text paste inside the description field", async () => {
    const textarea = modal().querySelector("textarea") as HTMLTextAreaElement;
    dispatchPaste(textarea, textClipboardData());
    await flushAsync();
    expect(chips()).toHaveLength(0);
  });

  it("removes the chip with × without submitting", async () => {
    const textarea = modal().querySelector("textarea") as HTMLTextAreaElement;
    dispatchPaste(textarea, imageClipboardData());
    await flushAsync();
    expect(chips()).toHaveLength(1);

    const remove = modal().querySelector(
      ".vibeflow-paste-remove",
    ) as HTMLButtonElement;
    await act(async () => {
      remove.click();
    });
    expect(chips()).toHaveLength(0);
    expect(onSubmitTask).not.toHaveBeenCalled();
  });

  it("uploads the pasted file on save with the kanban octet-stream contract", async () => {
    const textarea = modal().querySelector("textarea") as HTMLTextAreaElement;
    dispatchPaste(textarea, imageClipboardData());
    await flushAsync();
    expect(chips()).toHaveLength(1);

    const title = modal().querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    act(() => {
      setInputValue(title, "Pasted screenshot task");
    });

    const save = modal().querySelector(".btn-primary") as HTMLButtonElement;
    await act(async () => {
      save.click();
    });

    expect(onSubmitTask).toHaveBeenCalledTimes(1);
    const submittedTitle = onSubmitTask.mock.calls[0][2] as string;
    expect(submittedTitle).toBe("Pasted screenshot task");

    const upload = fetchCalls.find(
      (c) =>
        c.url.includes("/api/tasks/task-1/files/") &&
        c.init.method === "POST",
    );
    expect(upload).toBeDefined();
    expect(upload?.url).toMatch(
      /\/api\/tasks\/task-1\/files\/paste-.*\.png$/,
    );
    expect(upload?.init.headers).toEqual({
      "Content-Type": "application/octet-stream",
    });
    expect(new Uint8Array(upload?.init.body as ArrayBuffer)).toEqual(
      PNG_BYTES,
    );
  });
});
