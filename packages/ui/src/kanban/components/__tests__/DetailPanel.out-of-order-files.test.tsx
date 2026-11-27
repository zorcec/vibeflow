// @vitest-environment jsdom
/**
 * Out-of-order files responses never paint onto the wrong task (ticket
 * d6hkvg4v). Only `loadComments` guarded its writes with a generation
 * counter; `loadFiles` and `loadPanelData` wrote `files`, `filesLoaded` and
 * `fileCount` unguarded, so opening task A and switching to B before A's
 * `getFiles` resolved left A's file list, thumbnail and count on B.
 *
 * Two loaders touch the files state, so two cases:
 *  - `files` tab: the tab effect's `loadFiles` AND the open effect's
 *    `loadPanelData` both fetch — whichever resolves last used to win.
 *  - `details` tab: only `loadPanelData` fetches, isolating its guard.
 *
 * Non-vacuity: each case fails when its loader's guard is removed — A's
 * gated response lands last and `a-file.png` appears in B's list.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";
import type { FileEntry, Task } from "../../types";

function fileNamed(name: string): FileEntry {
  return { name, url: `http://localhost:3700/api/files/${name}` };
}

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    status: "todo",
    type: "Task",
    priority: null,
    description: "",
    tags: [],
    comments: [],
    files: [],
    links: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Task;
}

interface Deferred {
  promise: Promise<void>;
  release: () => void;
}

function deferred(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function renderPanel(
  task: Task,
  tab: "details" | "files",
  getFiles: (taskId: string) => Promise<{ files: FileEntry[] }>,
) {
  const api = {
    getComments: vi.fn().mockResolvedValue({ comments: [] }),
    getFiles: vi.fn().mockImplementation(getFiles),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as React.ComponentProps<typeof DetailPanel>["api"];
  const ui = render(
    <DetailPanel
      open={true}
      task={task}
      tab={tab}
      baseUrl="http://localhost:3700"
      api={api}
      onClose={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onPatch={vi.fn()}
      onFilePreview={vi.fn()}
    />,
  );
  const panel = (next: Task) =>
    ui.rerender(
      <DetailPanel
        open={true}
        task={next}
        tab={tab}
        baseUrl="http://localhost:3700"
        api={api}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onPatch={vi.fn()}
        onFilePreview={vi.fn()}
      />,
    );
  return { api, panel };
}

/** A's fetch is gated; B's answers immediately. */
function gatedGetFiles() {
  const gateA = deferred();
  const getFiles = async (taskId: string) => {
    if (taskId === "task-a") {
      await gateA.promise;
      return { files: [fileNamed("a-file.png")] };
    }
    return { files: [fileNamed("b-file.png")] };
  };
  return { gateA, getFiles };
}

async function flush() {
  // Let released promises (and the state updates they schedule) settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function filesPaneText(): string {
  const pane = document.querySelector("#dp-files-pane");
  expect(pane).not.toBeNull();
  return pane!.textContent ?? "";
}

function fileCountText(): string | null {
  return document.querySelector("#dp-file-count")?.textContent ?? null;
}

describe("DetailPanel keeps the current task's files (d6hkvg4v)", () => {
  it("files tab: A's late response cannot overwrite B's list", async () => {
    const { gateA, getFiles } = gatedGetFiles();
    const { panel } = renderPanel(makeTask("task-a"), "files", getFiles);

    // A is still in flight; switch to B.
    panel(makeTask("task-b"));
    await waitFor(() => expect(filesPaneText()).toContain("b-file.png"));
    expect(filesPaneText()).not.toContain("a-file.png");
    expect(fileCountText()).toBe("(1)");

    // A's response now lands, after B's.
    gateA.release();
    await flush();

    expect(filesPaneText()).toContain("b-file.png");
    expect(filesPaneText()).not.toContain("a-file.png");
    expect(fileCountText()).toBe("(1)");
  });

  it("details tab: A's late panel load cannot overwrite B's list", async () => {
    const { gateA, getFiles } = gatedGetFiles();
    const { panel } = renderPanel(makeTask("task-a"), "details", getFiles);

    panel(makeTask("task-b"));
    await waitFor(() => expect(filesPaneText()).toContain("b-file.png"));
    expect(fileCountText()).toBe("(1)");

    gateA.release();
    await flush();

    expect(filesPaneText()).toContain("b-file.png");
    expect(filesPaneText()).not.toContain("a-file.png");
    expect(fileCountText()).toBe("(1)");
  });
});
