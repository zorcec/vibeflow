// @vitest-environment jsdom
/**
 * Ticket d4c533f9 — the detail pane's markdown editors must not assume the
 * CLI-board API.
 *
 * `MarkdownEditableField` used to `fetch('/api/tasks')` on every mount for
 * the `#` mention index. That endpoint exists only on the CLI board; in the
 * web app every mount 404'd (4× per task open in tmp/localhost.har, doubled
 * again by StrictMode). With `mentionTasks` provided the editor indexes
 * from memory and never fetches. Without it the legacy fetch remains (CLI
 * board + standalone consumers), and the same holds for the preview's
 * `taskLookup` vs its `GET /api/tasks/:id` hover fetch.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MarkdownEditableField } from "../shared/MarkdownEditableField";

type FieldProps = React.ComponentProps<typeof MarkdownEditableField>;

const BASE: FieldProps = {
  value: "",
  onChange: () => {},
  showPreview: false,
  setShowPreview: () => {},
  previewId: "t-preview",
  textareaId: "t-input",
  placeholder: "Type…",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MarkdownEditableField mention index source", () => {
  it("never fetches when mentionTasks is provided, and suggests from it", async () => {
    const fetchMock = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const onChange = vi.fn();
    render(
      <MarkdownEditableField
        {...BASE}
        onChange={onChange}
        mentionTasks={[{ id: "abc123", title: "Alpha task" }]}
      />,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // Typing `#al` offers the provided task; picking it inserts the ref.
    const box = screen.getByPlaceholderText("Type…");
    fireEvent.change(box, { target: { value: "#al" } });
    const option = await screen.findByText("Alpha task");
    expect(option).toBeInTheDocument();
    fireEvent.mouseDown(option);
    expect(onChange).toHaveBeenCalledWith(
      expect.stringContaining("#abc123"),
    );
  });

  it("keeps the legacy /api/tasks fetch when mentionTasks is omitted", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        json: () => Promise.resolve({ tasks: [{ id: "z9", title: "Zed" }] }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<MarkdownEditableField {...BASE} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks");
  });

  it("resolves hover cards from taskLookup without fetching", async () => {
    const fetchMock = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const id = "a".repeat(30);
    render(
      <MarkdownEditableField
        {...BASE}
        showPreview
        value={`see #${id} for details`}
        mentionTasks={[{ id, title: "Looked up" }]}
        taskLookup={(hit: string) =>
          hit === id ? { title: "Looked up", status: "done" } : undefined
        }
      />,
    );
    const link = document.querySelector("a[data-task-ref]");
    expect(link).not.toBeNull();
    fireEvent.mouseOver(link!);
    await screen.findByText("Looked up");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
