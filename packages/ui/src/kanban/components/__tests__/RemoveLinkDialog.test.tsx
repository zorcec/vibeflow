import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RemoveLinkDialog } from "../RemoveLinkDialog";

describe("RemoveLinkDialog", () => {
  it("renders simple confirm for childless task", () => {
    render(
      <RemoveLinkDialog
        open={true}
        childTitle="My Task"
        childCount={0}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/Remove parent link from/)).toBeInTheDocument();
    expect(screen.getByText(/My Task/)).toBeInTheDocument();
    expect(screen.getByText(/root task/)).toBeInTheDocument();
    // No radio buttons
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("renders radio options when child has children", () => {
    render(
      <RemoveLinkDialog
        open={true}
        childTitle="Parent Task"
        childCount={3}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    // Text is split across <strong> tags, so use container
    const dialog = document.getElementById("remove-link-dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog!.textContent).toContain("3");
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(screen.getByText(/Children move up/)).toBeInTheDocument();
    expect(screen.getByText(/Delete children/)).toBeInTheDocument();
  });

  it("childCount=1 renders singular", () => {
    render(
      <RemoveLinkDialog
        open={true}
        childTitle="Solo"
        childCount={1}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const dialog = document.getElementById("remove-link-dialog");
    expect(dialog!.textContent).toContain("1");
    expect(screen.getByText(/child task/)).toBeInTheDocument();
  });

  it("cancel calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <RemoveLinkDialog
        open={true}
        childTitle="X"
        childCount={0}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("confirm calls onConfirm with false by default (move-up)", () => {
    const onConfirm = vi.fn();
    render(
      <RemoveLinkDialog
        open={true}
        childTitle="X"
        childCount={2}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText("Remove"));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("selecting delete-children radio calls onConfirm with true", () => {
    const onConfirm = vi.fn();
    render(
      <RemoveLinkDialog
        open={true}
        childTitle="X"
        childCount={2}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[1]); // delete children
    fireEvent.click(screen.getByText("Remove"));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("does not render when closed", () => {
    const { container } = render(
      <RemoveLinkDialog
        open={false}
        childTitle="X"
        childCount={0}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(container.querySelector("[id='remove-link-dialog']")).toBeNull();
  });
});
