import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FilesList } from "../shared/FilesList";
import type { FileEntry } from "../../types";

/**
 * Non-vacuity: grouping consults ONLY the system flag. A file named
 * verify-after.json with no flag renders as a USER file (this fails if
 * anyone re-adds name matching); the same name with system: true renders
 * under the collapsed SYSTEM group.
 */
describe("FilesList system grouping", () => {
  const onPreview = vi.fn();

  function renderList(files: FileEntry[]) {
    return render(
      <FilesList
        files={files}
        loading={false}
        error={null}
        baseUrl="http://localhost:9999"
        taskId="abc123"
        onPreview={onPreview}
      />,
    );
  }

  it("engine-named file WITHOUT the flag renders as a user file", () => {
    renderList([
      { name: "verify-after.json", url: "http://x/verify-after.json" },
    ]);
    // User files render inline, not behind the SYSTEM toggle.
    expect(screen.queryByText(/Captured by Vibeflow/)).not.toBeInTheDocument();
    expect(screen.getByText("verify-after.json")).toBeInTheDocument();
  });

  it("flagged engine file renders under the SYSTEM group", () => {
    renderList([
      {
        name: "verify-after.json",
        url: "http://x/verify-after.json",
        system: true,
      },
    ]);
    // Collapsed by default: toggle visible, file hidden until expanded.
    expect(screen.getByText(/Captured by Vibeflow \(1\)/)).toBeInTheDocument();
    expect(screen.queryByText("verify-after.json")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Captured by Vibeflow \(1\)/));
    expect(screen.getByText("verify-after.json")).toBeInTheDocument();
  });

  it("user file with an engine lookalike name stays a user file", () => {
    renderList([{ name: "verify-notes.md", url: "http://x/verify-notes.md" }]);
    expect(screen.queryByText(/Captured by Vibeflow/)).not.toBeInTheDocument();
    expect(screen.getByText("verify-notes.md")).toBeInTheDocument();
  });

  it("caption uses timing-accurate copy", () => {
    renderList([
      {
        name: "baseline-element.json",
        url: "http://x/baseline-element.json",
        system: true,
      },
    ]);
    fireEvent.click(screen.getByText(/Captured by Vibeflow \(1\)/));
    expect(
      screen.getByText(
        /Baselines captured at annotation time, verify evidence re-captured/,
      ),
    ).toBeInTheDocument();
  });
});
