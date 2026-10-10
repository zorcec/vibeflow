import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Header } from "../Header";

/**
 * Regression tests for the board-configured header icon.
 *
 * The board icon arrives as `projectIcon` (already plumbed by both kanban
 * shells) but the header has repeatedly regressed to painting the hardcoded
 * Vibeflow brand mark instead — so these tests assert the *arbitration*,
 * not just presence: a provided icon must render AND the Vibeflow mark must
 * be absent, and vice versa. A test that only asks "is there an icon?"
 * passes on the broken code.
 *
 * Deliberately assertion-based, not snapshot-based: a snapshot of the fixed
 * header passes just as happily on a header that ignores `projectIcon` once
 * the snapshot is regenerated.
 */

function renderHeader(extra: Partial<React.ComponentProps<typeof Header>> = {}) {
  return render(
    <Header
      projectName="Acme Board"
      searchQuery=""
      onSearchChange={vi.fn()}
      onSettings={vi.fn()}
      taskSummary="3 tasks"
      {...extra}
    />,
  );
}

describe("Header board icon", () => {
  it("renders the board-configured projectIcon when one is provided", () => {
    renderHeader({
      projectIcon: "🚀",
      missingProjectIconStyle: "vibeflow",
    });
    // The configured board icon is shown …
    expect(screen.getByText("🚀")).toBeInTheDocument();
    // … and the hardcoded Vibeflow brand mark is NOT.
    expect(screen.queryByLabelText("Vibeflow")).not.toBeInTheDocument();
  });

  it("falls back to the Vibeflow brand mark when the board has no icon (CLI kanban path)", () => {
    renderHeader({ missingProjectIconStyle: "vibeflow" });
    const mark = screen.getByLabelText("Vibeflow");
    expect(mark.tagName.toLowerCase()).toBe("svg");
    expect(mark).toHaveAttribute("width", "32");
    expect(mark).toHaveAttribute("height", "32");
  });

  it("default style renders the initial-letter avatar, not the Vibeflow mark", () => {
    const { container } = renderHeader();
    expect(screen.queryByLabelText("Vibeflow")).not.toBeInTheDocument();
    // "Acme Board" -> initial "A" avatar with the project name as title.
    const avatar = container.querySelector('[title="Acme Board"]');
    expect(avatar).not.toBeNull();
    expect(avatar).toHaveTextContent("A");
  });

  it("treats a whitespace-only projectIcon as missing", () => {
    renderHeader({
      projectIcon: "   ",
      missingProjectIconStyle: "vibeflow",
    });
    expect(screen.getByLabelText("Vibeflow")).toBeInTheDocument();
  });

  it("keeps the 32px icon box whether the board icon or the brand mark is shown", () => {
    const withBoardIcon = renderHeader({
      projectIcon: "🚀",
      missingProjectIconStyle: "vibeflow",
    });
    // getByText resolves to the icon box div itself (its full text is the icon).
    const boardIconBox = screen.getByText("🚀");
    expect(boardIconBox.style.width).toBe("32px");
    expect(boardIconBox.style.height).toBe("32px");
    withBoardIcon.unmount();

    renderHeader({ missingProjectIconStyle: "vibeflow" });
    const brandBox = screen.getByLabelText("Vibeflow").parentElement;
    expect(brandBox?.style.width).toBe("32px");
    expect(brandBox?.style.height).toBe("32px");
  });
});
