// @vitest-environment jsdom
/**
 * Pasted-screenshot processing state (14b61260).
 *
 * Pasting a screenshot used to show nothing for the seconds the wasm
 * transform + upload take, and a failed upload failed silently (an unhandled
 * rejection from a `void` listener call). These tests pin the corrected
 * state machine on both paste surfaces:
 *
 *   existing task → pending tile the moment paste lands, Upload disabled
 *   while busy, tile clears exactly when the stored file is listed, and any
 *   failure (transform / upload rejection / upload that resolves without
 *   the file appearing) lands in the visible upload-error box.
 *
 *   create-task mode → "Processing pasted image…" pill immediately, then the
 *   buffered 📎 note; transform failures surface instead of vanishing.
 *
 * jsdom has no DataTransfer constructor, so the tests dispatch a plain Event
 * with a structurally identical `clipboardData` ({ items: [...] }) — the
 * handler only reads `clipboardData.items`, `type`/`kind` and `getAsFile`.
 * The real `transformImageForUpload` runs: without a browser image pipeline
 * it takes the passthrough branch, which is exactly the slow-path shape the
 * pending tile covers (tile appears before the async transform resolves).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";
import { FilesList } from "../shared/FilesList";
import type { Task, FileEntry } from "../../types";

function makeTask(): Task {
  return {
    id: "t1",
    title: "Paste Test Task",
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

interface ApiMocks {
  uploadFile: ReturnType<typeof vi.fn>;
  getFiles: ReturnType<typeof vi.fn>;
}

function baseApi(listed: FileEntry[] = []): ApiMocks {
  return {
    uploadFile: vi.fn().mockResolvedValue(undefined),
    getFiles: vi.fn().mockResolvedValue({ files: listed }),
  };
}

function renderFilesPanel(
  task: Task | null,
  api: ApiMocks,
  tab: React.ComponentProps<typeof DetailPanel>["tab"] = "files",
) {
  return render(
    <DetailPanel
      open={true}
      task={task}
      tab={tab}
      baseUrl="http://localhost:3700"
      api={
        {
          getComments: vi.fn().mockResolvedValue({ comments: [] }),
          getFiles: api.getFiles,
          uploadFile: api.uploadFile,
          loadBadgeCounts: vi.fn().mockResolvedValue({ comments: 0, files: 0 }),
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

describe("paste processing state (existing task)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a pending tile immediately on paste and clears it when the stored file renders", async () => {
    let uploadedName = "";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = baseApi();
    api.uploadFile.mockImplementation(async (_taskId: string, file: File) => {
      uploadedName = file.name;
      await gate;
    });
    api.getFiles.mockImplementation(async () => ({
      files: uploadedName
        ? [{ name: uploadedName, url: `/api/files/${uploadedName}` } as FileEntry]
        : [],
    }));
    renderFilesPanel(makeTask(), api);

    // 1. paste → processing is visible while the upload is still in flight:
    // the pending tile on the file itself plus the Files-pane banner.
    pasteOnDocument([imageItem(pngFile())]);
    await screen.findByText("Processing pasted image…");
    expect(document.querySelector(".file-pending")).not.toBeNull();
    expect(screen.getByText("Uploading pasted image…")).toBeInTheDocument();
    expect(screen.getByText("Uploading…")).toBeInTheDocument();

    // 2. upload settles → tile clears exactly when the stored file renders.
    // The stored file renders in both the normal FilesList row and the
    // compact activity row, so assert at least one titled node exists.
    release();
    await waitFor(() => {
      expect(document.querySelector(".file-pending")).toBeNull();
    });
    const titled = await screen.findAllByTitle(uploadedName);
    expect(titled.length).toBeGreaterThanOrEqual(1);
    expect(
      screen.queryByText(/Couldn't attach/),
    ).not.toBeInTheDocument();
  });

  it("refuses a second submission while one is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = baseApi();
    api.uploadFile.mockImplementation(() => gate);
    renderFilesPanel(makeTask(), api);

    pasteOnDocument([imageItem(pngFile("first.png"))]);
    await screen.findByText("Processing pasted image…");
    pasteOnDocument([imageItem(pngFile("second.png"))]);
    // Give the ignored second paste a chance to (not) act.
    await new Promise((r) => setTimeout(r, 50));
    expect(api.uploadFile).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => {
      expect(document.querySelector(".file-pending")).toBeNull();
    });
  });

  it("a rejected upload clears the tile and shows the failure instead of failing silently", async () => {
    const api = baseApi();
    api.uploadFile.mockRejectedValue(new Error("HTTP 500"));
    renderFilesPanel(makeTask(), api);

    pasteOnDocument([imageItem(pngFile())]);
    await screen.findByText("Processing pasted image…");
    const err = await screen.findByText(/Couldn't attach/);
    expect(err.textContent).toContain("HTTP 500");
    expect(document.querySelector(".file-pending")).toBeNull();
  });

  it("an upload that resolves without the file appearing is treated as a failure", async () => {
    const api = baseApi(); // getFiles keeps returning []
    renderFilesPanel(makeTask(), api);

    pasteOnDocument([imageItem(pngFile())]);
    await screen.findByText("Processing pasted image…");
    const err = await screen.findByText(/Couldn't attach/);
    expect(err.textContent).toContain("not listed");
    expect(document.querySelector(".file-pending")).toBeNull();
  });

  it("uploads a selected non-image file larger than 5 MiB", async () => {
    const api = baseApi();
    renderFilesPanel(makeTask(), api);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.bin", { type: "application/octet-stream" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledWith("t1", file));
  });

  it("a pasted non-image file gets the same tracked treatment", async () => {
    const api = baseApi();
    let uploaded: File | null = null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.uploadFile.mockImplementation(async (_t: string, f: File) => {
      uploaded = f;
      await gate;
    });
    api.getFiles.mockImplementation(async () => ({
      files: uploaded
        ? [{ name: (uploaded as unknown as File).name, url: "/x" } as FileEntry]
        : [],
    }));
    renderFilesPanel(makeTask(), api);

    const csv = new File(["a,b"], "data.csv", { type: "text/csv" });
    pasteOnDocument([
      { type: "text/csv", kind: "file", getAsFile: () => csv },
    ]);
    await screen.findByText("Processing file…");
    expect(document.querySelector(".file-pending")).not.toBeNull();
    release();
    await waitFor(() => {
      expect(document.querySelector(".file-pending")).toBeNull();
    });
    // The stored file renders in both the normal FilesList row and the
    // compact activity row, so assert at least one titled node exists.
    const csvTitled = await screen.findAllByTitle("data.csv");
    expect(csvTitled.length).toBeGreaterThanOrEqual(1);
  });
});

describe("paste processing state (create-task mode)", () => {
  it("shows processing immediately, then the buffered note", async () => {
    const api = baseApi();
    renderFilesPanel(null, api, "details");

    pasteOnDocument([imageItem(pngFile())]);
    await screen.findByText("Processing pasted image…");
    await waitFor(() => {
      expect(
        screen.queryByText("Processing pasted image…"),
      ).not.toBeInTheDocument();
    });
    expect(await screen.findByText(/will attach on save/)).toBeInTheDocument();
  });
});

describe("FilesList pending tiles", () => {
  it("renders pending tiles even when no stored files exist yet", () => {
    const { container } = render(
      <FilesList
        files={[]}
        loading={false}
        error={null}
        baseUrl="http://localhost:3700"
        pendingFiles={[{ name: "paste-2026-10-12T00-00-05.png", image: true }]}
        onPreview={vi.fn()}
      />,
    );
    expect(
      container.querySelector(".file-pending"),
    ).not.toBeNull();
    expect(
      container.querySelector(".file-pending")?.textContent,
    ).toContain("paste-2026-10-12T00-00-05.png");
    // The empty-list message yields to the pending tile.
    expect(screen.queryByText("No files attached.")).not.toBeInTheDocument();
  });

  it("renders nothing pending by default", () => {
    const { container } = render(
      <FilesList
        files={[]}
        loading={false}
        error={null}
        baseUrl="http://localhost:3700"
        onPreview={vi.fn()}
      />,
    );
    expect(container.querySelector(".file-pending")).toBeNull();
    expect(screen.getByText("No files attached.")).toBeInTheDocument();
  });
});
