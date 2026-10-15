// @vitest-environment jsdom
/**
 * Add-task panel close timing (ticket 7fd3280b).
 *
 * The owner reported the kanban "Add Task" flow still felt slow after the
 * optimistic card landed: the add panel awaited the full `task.create`
 * round-trip before calling `onClose`, sitting open with no spinner while
 * the already-painted optimistic card hid behind it.
 *
 * Pinned contract:
 *   1. Clicking "Add Task" calls `onClose` synchronously — even when the
 *      `onCreate` promise never resolves (the create round-trip must not
 *      hold the panel open).
 *   2. Files pasted during creation still upload, but in the background:
 *      no upload starts before the create resolves (the real id is needed),
 *      and a refused create (no id) drops them without uploading.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";

vi.useRealTimers();

function pngFile(name = "shot.png"): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, {
    type: "image/png",
  });
}

function imageItem(file: File) {
  return { type: "image/png", kind: "file" as const, getAsFile: () => file };
}

function pasteOnDocument(items: unknown[]) {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  (e as unknown as Record<string, unknown>).clipboardData = { items };
  document.dispatchEvent(e);
}

interface AddHarness {
  onCreate: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  uploadFile: ReturnType<typeof vi.fn>;
  releaseCreate: (id: string | undefined) => void;
}

function renderAddPanel(): AddHarness {
  let releaseCreate!: (id: string | undefined) => void;
  const onCreate = vi.fn(
    () =>
      new Promise<string | undefined>((resolve) => {
        releaseCreate = resolve;
      }),
  );
  const onClose = vi.fn();
  const uploadFile = vi.fn().mockResolvedValue(undefined);
  render(
    <DetailPanel
      open={true}
      task={null}
      tab="details"
      baseUrl="http://localhost:3700"
      api={
        {
          getComments: vi.fn().mockResolvedValue({ comments: [] }),
          getFiles: vi.fn().mockResolvedValue({ files: [] }),
          uploadFile,
        } as unknown as React.ComponentProps<typeof DetailPanel>["api"]
      }
      onClose={onClose}
      onCreate={onCreate}
      onDelete={vi.fn()}
      onPatch={vi.fn()}
      onFilePreview={vi.fn()}
    />,
  );
  return {
    onCreate,
    onClose,
    uploadFile,
    releaseCreate: (id: string | undefined) => releaseCreate(id),
  };
}

function addTaskWithTitle(title: string) {
  fireEvent.change(screen.getByPlaceholderText("Task title…"), {
    target: { value: title },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add Task" }));
}

describe("DetailPanel add close timing (7fd3280b)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls onClose synchronously on Add even while the create is still in flight", () => {
    const { onCreate, onClose, uploadFile } = renderAddPanel();
    addTaskWithTitle("Close me now");

    // No await between click and assertions: the panel must not wait.
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toMatchObject({ title: "Close me now" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("uploads pasted files in the background once the create resolves with the real id", async () => {
    const { onClose, uploadFile, releaseCreate } = renderAddPanel();
    pasteOnDocument([imageItem(pngFile())]);
    await screen.findByText(/will attach on/);

    addTaskWithTitle("Task with paste");
    expect(onClose).toHaveBeenCalledTimes(1);
    // The real id does not exist yet — nothing may upload before resolve.
    expect(uploadFile).not.toHaveBeenCalled();

    releaseCreate("real-9");
    await waitFor(() =>
      expect(uploadFile).toHaveBeenCalledWith(
        "real-9",
        expect.any(File),
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uploads nothing when the create is refused (no id)", async () => {
    const { onClose, uploadFile, releaseCreate } = renderAddPanel();
    pasteOnDocument([imageItem(pngFile())]);
    await screen.findByText(/will attach on/);

    addTaskWithTitle("Refused task");
    expect(onClose).toHaveBeenCalledTimes(1);

    releaseCreate(undefined);
    // Let the background continuation run, then confirm silence.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
