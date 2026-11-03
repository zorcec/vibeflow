// @vitest-environment jsdom
/**
 * FileItem onDownload (fkc58xkd0kq1vbge2c4gbp8l): a bare `<a href download>`
 * cannot send the X-Vibeflow-Scope header, so the v0 file route fails closed
 * (403 'Board scope required'). When onDownload is provided both variants
 * render a button that delegates to it (the caller fetches with scope
 * headers); when absent the legacy anchor is unchanged.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FileItem } from "../shared/FileItem";
import type { FileEntry } from "../../types";

const file: FileEntry = { name: "shot.png", url: "/api/files/shot.png", size: 42 };
const url = "https://board.example/api/files/shot.png";

describe.each(["normal", "compact"] as const)("FileItem %s variant download", (variant) => {
  it("renders the legacy anchor when onDownload is absent", () => {
    render(<FileItem file={file} url={url} variant={variant} />);
    const anchor = screen.getByTitle("Download");
    expect(anchor.tagName).toBe("A");
    expect(anchor).toHaveAttribute("href", url);
  });

  it("renders a button delegating to onDownload when provided", () => {
    const onDownload = vi.fn();
    render(<FileItem file={file} url={url} variant={variant} onDownload={onDownload} />);
    const button = screen.getByTitle("Download");
    expect(button.tagName).toBe("BUTTON");
    fireEvent.click(button);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledWith(file, url);
  });
});
