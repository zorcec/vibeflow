import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Header } from "../Header";
import { FilterBar } from "../FilterBar";

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../kanban.css"),
  "utf8",
);

function renderHeader() {
  return render(
    <Header
      projectName="A long mobile project title"
      searchQuery=""
      taskSummary="1 open"
      onSearchChange={vi.fn()}
      onSettings={vi.fn()}
      extraActions={<button id="overview-btn">Overview</button>}
    />,
  );
}

describe("shared mobile header and filter reflow", () => {
  it("keeps search and hidden header actions reachable from an accessible menu", () => {
    const view = renderHeader();
    expect(view.getByRole("textbox", { name: "Search tasks" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Open board menu" }));
    const menu = view.getByLabelText("Board actions");
    expect(menu).toBeTruthy();
    expect(menu.querySelector("#overview-btn")).toBeTruthy();
    expect(menu.querySelector("#btn-settings")).toBeTruthy();
  });

  it("keeps status, filter, and view controls in a wrapping narrow layout", () => {
    const view = render(
      <FilterBar
        tasks={[]}
        filter={{ status: "all", component: null, type: null, user: null, tags: [] }}
        onFilter={vi.fn()}
        view="list"
      />,
    );
    expect(view.getByTestId("filter-bar").className).toContain("kb-filter-bar");
    expect(view.getByRole("button", { name: "All" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Tags" })).toBeTruthy();
    expect(view.getByRole("button", { name: "User" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Board view" })).toBeTruthy();
    expect(css).toMatch(/@media\s*\(max-width:\s*767px\)/);
    expect(css).toMatch(/\.kb-filter-bar\s*\{[^}]*flex-wrap:\s*wrap/s);
  });
});
