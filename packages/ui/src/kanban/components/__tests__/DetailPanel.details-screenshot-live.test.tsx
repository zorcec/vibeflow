// @vitest-environment jsdom
/**
 * Details-tab screenshot preview follows the live files channel (dd380f25).
 *
 * Scenario: the panel sits on the DETAILS tab while a peer uploads an image
 * (the host bumps `fileVersion`). The details screenshot renders from the
 * `files` list — not the count — so a count-only refresh leaves the preview
 * stale until the user opens the files tab. The fix reloads the full files
 * list on every file bump, on any tab (same getFiles request, minus
 * discarding the result).
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";
import type { Task } from "../../types";

function bareTask(): Task {
  return {
    id: "t1",
    title: "Screenshot trace task",
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

type ApiProp = React.ComponentProps<typeof DetailPanel>["api"];

function makeApi(
  getFiles: () => Promise<{ files: Array<{ name: string; url: string }> }>,
): ApiProp {
  return {
    getComments: vi.fn().mockResolvedValue({ comments: [] }),
    getFiles,
    uploadFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApiProp;
}

function panelFor(api: ApiProp, fileVersion: number) {
  return (
    <DetailPanel
      open={true}
      task={bareTask()}
      tab="details"
      baseUrl="http://localhost:3700"
      api={api}
      onClose={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onPatch={vi.fn()}
      onFilePreview={vi.fn()}
      commentVersion={1}
      fileVersion={fileVersion}
    />
  );
}

describe("details screenshot follows the live files channel (dd380f25)", () => {
  it("a file bump on the details tab reloads the list, so the preview appears", async () => {
    let peerUploaded = false;
    const getFiles = vi.fn().mockImplementation(async () => {
      if (!peerUploaded) return { files: [] };
      return {
        files: [{ name: "peer-shot.png", url: "http://x/peer-shot.png" }],
      };
    });
    const api = makeApi(getFiles);
    const { rerender } = render(panelFor(api, 1));

    // No files yet: no preview, on the details tab.
    await waitFor(() => expect(getFiles).toHaveBeenCalled());
    expect(document.querySelector("#dp-screenshot-preview")).toBeNull();

    // The peer uploads; the host bumps fileVersion while we stay on details.
    peerUploaded = true;
    rerender(panelFor(api, 2));

    // The preview appears without ever visiting the files tab.
    await waitFor(() => {
      expect(document.querySelector("#dp-screenshot-preview")).not.toBeNull();
    });
    expect(
      document.querySelector('#dp-screenshot-preview img[src*="peer-shot.png"]'),
    ).not.toBeNull();
  });
});
