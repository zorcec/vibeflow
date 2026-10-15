// @vitest-environment jsdom
/**
 * Removed file's image is never requested (ticket 17d42681).
 *
 * Scenario: the board snapshot still references an attached image
 * (`task.files` still lists it) but the fresh files fetch returns an empty
 * list — the file was removed (via the panel or externally through the API).
 * Once that fresh list lands it is authoritative: the details screenshot
 * preview must not render an `<img>` for the removed file. Before the fix,
 * DetailPanel mapped an empty fresh list to `liveFiles={undefined}`, which
 * made TaskDetailsTab fall back to the stale `task.files` ref — the panel
 * (still mounted behind `display:none` on the activity tab) requested the
 * deleted asset and the server answered 404.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";
import type { Task } from "../../types";

function staleSnapshotTask(): Task {
  return {
    id: "t1",
    title: "Removal trace task",
    status: "todo",
    type: "Task",
    priority: null,
    description: "",
    tags: [],
    comments: [],
    // Stale board snapshot: still references the removed file.
    files: [{ name: "trace-test.png", addedAt: "2026-01-01T00:00:00.000Z" }],
    links: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Task;
}

function renderDetailsPanel(task: Task, getFiles: () => Promise<{ files: [] }>) {
  return render(
    <DetailPanel
      open={true}
      task={task}
      tab="details"
      baseUrl="http://localhost:3700"
      api={
        {
          getComments: vi.fn().mockResolvedValue({ comments: [] }),
          getFiles,
          uploadFile: vi.fn().mockResolvedValue(undefined),
          deleteFile: vi.fn().mockResolvedValue(undefined),
        } as unknown as React.ComponentProps<typeof DetailPanel>["api"]
      }
      onClose={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onPatch={vi.fn()}
      onFilePreview={vi.fn()}
    />,
  );
}

describe("removed file's image is never requested (17d42681)", () => {
  it("renders no screenshot <img> for a file missing from the fresh files list", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Fresh server state: the file is gone. Gated so the test observes the
    // post-fetch render, not just the pre-fetch fallback.
    const getFiles = vi.fn().mockImplementation(async () => {
      await gate;
      return { files: [] };
    });
    renderDetailsPanel(staleSnapshotTask(), getFiles);

    // While the fresh list is in flight the panel still shows the board
    // snapshot's preview — that loading fallback is expected; the defect is
    // holding onto it AFTER the fresh list says the file is gone.
    expect(
      document.querySelector('img[src*="trace-test.png"]'),
    ).not.toBeNull();

    release();
    await waitFor(
      () => {
        expect(getFiles).toHaveBeenCalled();
        expect(
          document.querySelector('img[src*="trace-test.png"]'),
        ).toBeNull();
      },
      { timeout: 5_000 },
    );
    // And the whole screenshot block goes away with it — no stale caption,
    // no Preview/Remove buttons pointing at a deleted asset.
    expect(
      document.querySelector("#dp-screenshot-preview"),
    ).toBeNull();
  });
});
