// @vitest-environment jsdom
/**
 * Overlay add-task modal: paste processing + failure states (14b61260 round 2).
 *
 * The board got its pending/failure paste states in round 1 but the overlay
 * never did: a paste showed nothing for the seconds the wasm transform takes,
 * and a transform failure was an unhandled rejection with no visible feedback.
 * These tests pin the corrected state machine on the overlay add-task modal:
 *
 *   paste → "Processing pasted image…" IMMEDIATELY (while the transform is
 *   still in flight) → chip exactly when the file is buffered;
 *   transform rejection → "Couldn't attach pasted image: …" error box with
 *   zero pending pills and zero chips, instead of silence.
 *
 * `pastedImageToFile` is mocked to a controllable deferred so the in-flight
 * window is deterministic; timings are measured around the assertions.
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

vi.mock("../../../src/client/overlay-browser/paste.js", async (
  importOriginal,
) => {
  const actual = await importOriginal<
    typeof import("../../../src/client/overlay-browser/paste.js")
  >();
  return {
    ...actual,
    pastedImageToFile: (...args: unknown[]) =>
      (
        globalThis as unknown as {
          __overlayPasteImpl: (...a: unknown[]) => Promise<File>;
        }
      ).__overlayPasteImpl(...args),
  };
});

const PNG_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
  120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 160, 90, 186, 57, 0, 0, 0, 0,
  73, 69, 78, 68, 174, 66, 96, 130,
]);
const API = "http://localhost:9/api/tasks";

function imageClipboardData() {
  const file = new File([PNG_BYTES], "clipboard.png", { type: "image/png" });
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

/** Paste must bubble from the field to the dialog listener, like a real keypress. */
function dispatchPaste(target: Element, clipboardData: unknown): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  (event as unknown as Record<string, unknown>).clipboardData = clipboardData;
  target.dispatchEvent(event);
}

describe("OverlayAddModal paste processing state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("PROTO_CONFIG", { apiUrl: API });
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(
      () => "blob:mock-thumb",
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(OverlayApp, {
          onOpenKanban: () => {},
          onSubmitTask: vi.fn(async () => ({ success: true })),
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
    delete (globalThis as unknown as Record<string, unknown>)
      .__overlayPasteImpl;
  });

  function modal(): HTMLElement {
    const dialog = container.querySelector(
      ".overlay-add-modal",
    ) as HTMLElement | null;
    expect(dialog).not.toBeNull();
    return dialog as HTMLElement;
  }

  it("shows processing immediately on paste and clears it exactly when the chip renders", async () => {
    let release!: (file: File) => void;
    const gate = new Promise<File>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    (
      globalThis as unknown as Record<string, unknown>
    ).__overlayPasteImpl = async () => {
      calls += 1;
      return gate;
    };

    const textarea = modal().querySelector("textarea") as HTMLTextAreaElement;
    const t0 = Date.now();
    dispatchPaste(textarea, imageClipboardData());
    // Let the synchronous state update land without resolving the transform.
    await act(async () => {
      await Promise.resolve();
    });
    const processingMs = Date.now() - t0;

    // 1. paste → processing is visible while the transform is in flight.
    const pending = modal().querySelector(".vibeflow-paste-processing");
    expect(pending?.textContent).toBe("Processing pasted image…");
    expect(modal().querySelectorAll(".vibeflow-paste-chip")).toHaveLength(0);
    expect(
      modal().querySelector(".vibeflow-paste-name"),
    ).toBeNull();
    expect(calls).toBe(1);

    // 2. transform settles → pill clears exactly when the chip renders.
    const done = new File([PNG_BYTES], "paste-2026-10-13T00-00-01.png", {
      type: "image/png",
    });
    release(done);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const settleMs = Date.now() - t0;
    expect(
      modal().querySelector(".vibeflow-paste-processing"),
    ).toBeNull();
    expect(modal().querySelector(".vibeflow-paste-name")?.textContent).toBe(
      "paste-2026-10-13T00-00-01.png",
    );
    expect(
      modal().querySelector(".vibeflow-paste-error"),
    ).toBeNull();

    // Measured evidence for the ticket report.
    expect(processingMs).toBeLessThan(1000);
    expect(settleMs).toBeGreaterThanOrEqual(processingMs);
  });

  it("a rejected transform clears the pill and shows the failure instead of failing silently", async () => {
    (
      globalThis as unknown as Record<string, unknown>
    ).__overlayPasteImpl = async () => {
      throw new Error("HTTP 500");
    };

    const textarea = modal().querySelector("textarea") as HTMLTextAreaElement;
    dispatchPaste(textarea, imageClipboardData());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const err = modal().querySelector(".vibeflow-paste-error");
    expect(err?.textContent).toContain("Couldn't attach pasted image");
    expect(err?.textContent).toContain("HTTP 500");
    expect(
      modal().querySelector(".vibeflow-paste-processing"),
    ).toBeNull();
    expect(modal().querySelector(".vibeflow-paste-name")).toBeNull();
  });
});
