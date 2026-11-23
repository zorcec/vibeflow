// @vitest-environment jsdom
/**
 * Watching badge placement in the shared header (ticket
 * cgor65lmpv31cib1ef9zce5m).
 *
 * The badge must sit with the header actions on a desk AND stay reachable on
 * a phone, where `.kb-header-desktop-actions` collapses into the menu. The
 * placement contract is therefore structural, not visual:
 *   - inside `.kb-header-actions` (next to the pills);
 *   - OUTSIDE `#kb-header-actions-menu` (the group hidden at <=767px);
 *   - its word label hides in the narrow block, leaving the count, so the
 *     pill never pushes the menu off a 375px header.
 * A host that does not pass `watching` renders no badge (older surfaces).
 */
import React from "react";
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "@testing-library/jest-dom";
import { Header } from "../Header";

const cssPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../kanban.css",
);

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = readFileSync(cssPath, "utf-8");
  document.head.appendChild(style);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderHeader(watching?: { endpoint: string }) {
  return render(
    <Header
      projectName="Watching board"
      searchQuery=""
      taskSummary="1 open"
      onSearchChange={vi.fn()}
      onSettings={vi.fn()}
      {...(watching !== undefined ? { watching } : {})}
    />,
  );
}

describe("Header watching badge", () => {
  it("renders no badge when the host does not provide a registry route", () => {
    const view = renderHeader();
    expect(view.container.querySelector("#watching-badge")).toBeNull();
  });

  it("places the badge with the header actions, outside the mobile-collapsed group", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({ total: 1, byUser: [], byAgent: [] }),
        } as Response),
      ),
    );
    const view = renderHeader({ endpoint: "/api/notifications/subscribers" });

    await waitFor(() =>
      expect(view.container.querySelector("#watching-badge")).not.toBeNull(),
    );
    const badge = view.container.querySelector("#watching-badge")!;
    expect(badge.closest(".kb-header-actions")).not.toBeNull();
    // The phone menu hides `.kb-header-desktop-actions`; a badge inside that
    // group would vanish on a phone, so it must be a SIBLING of it.
    expect(badge.closest("#kb-header-actions-menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Watching 1 agent" })).toBe(
      badge,
    );
  });

  it("hides the word label in the narrow-viewport block, keeping the count", () => {
    const narrow = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .filter(
        (rule): rule is CSSMediaRule =>
          rule instanceof CSSMediaRule &&
          /max-width:\s*767px/.test(rule.conditionText),
      );
    const rule = narrow
      .flatMap((media) => Array.from(media.cssRules))
      .find(
        (candidate): candidate is CSSStyleRule =>
          candidate instanceof CSSStyleRule &&
          candidate.selectorText
            .split(",")
            .map((selector) => selector.trim())
            .includes(".kb-watching-label"),
      );
    expect(rule, ".kb-watching-label rule in the narrow block").toBeTruthy();
    expect(rule!.style.getPropertyValue("display")).toBe("none");
  });
});
