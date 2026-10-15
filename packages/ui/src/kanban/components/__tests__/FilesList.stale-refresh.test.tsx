// @vitest-environment jsdom
/**
 * Stale-while-revalidate files list (vibeflow task fa0d3d0e).
 *
 * Same contract as the activity feed: pasting an image (or any refetch)
 * must not blank attachment rows the customer already sees. The full
 * Loading/Failed states render only when there is nothing to keep;
 * otherwise saved rows stay with a slim inline note.
 *
 * Non-vacuity: the "keeps saved rows" cases fail on the old code (it
 * returned early on `loading`/`error` whenever the flag was set — the file
 * name leaves the document), and the empty cases guard first-open loading.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FilesList } from "../shared/FilesList";
import type { FileEntry } from "../../types";

function file(name: string): FileEntry {
  return { name, url: `http://x/${name}` };
}

function renderList(files: FileEntry[], loading: boolean, error: string | null) {
  return render(
    <FilesList
      files={files}
      loading={loading}
      error={error}
      baseUrl="http://localhost:9999"
      onPreview={vi.fn()}
    />,
  );
}

describe("files list keeps saved rows during a refresh", () => {
  it("loading with saved files keeps the rows and notes the refresh inline", () => {
    const { container } = renderList([file("saved.png")], true, null);
    expect(container.textContent).toContain("saved.png");
    expect(container.textContent).not.toContain("Loading…");
    expect(container.querySelector("#dp-files-updating")).not.toBeNull();
  });

  it("loading with no files still shows the full Loading state", () => {
    const { container } = renderList([], true, null);
    expect(container.textContent).toContain("Loading…");
  });

  it("a failed refresh with saved files keeps the rows with a stale note", () => {
    const { container } = renderList([file("saved.png")], false, "failed");
    expect(container.textContent).toContain("saved.png");
    expect(container.textContent).not.toContain("Failed to load.");
    expect(container.querySelector("#dp-files-stale")).not.toBeNull();
  });

  it("a failed first load with no files still shows Failed to load", () => {
    const { container } = renderList([], false, "failed");
    expect(container.textContent).toContain("Failed to load.");
  });
});
