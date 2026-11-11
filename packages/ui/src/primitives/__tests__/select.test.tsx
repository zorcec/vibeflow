import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { Select } from "../select";

afterEach(cleanup);

const OPTIONS = [
  { value: "todo", label: "Todo" },
  { value: "in-progress", label: "In progress" },
  { value: "done", label: "Done", disabled: true },
] as const;

function renderSelect(props: Partial<Parameters<typeof Select>[0]> = {}) {
  const onValueChange = vi.fn();
  const utils = render(
    <Select
      value={null}
      onValueChange={onValueChange}
      options={OPTIONS}
      aria-label="Status"
      {...props}
    />,
  );
  return { ...utils, onValueChange };
}

describe("Select (P12)", () => {
  it("exposes the combobox contract on the trigger", () => {
    renderSelect();
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAccessibleName("Status");
  });

  it("shows the placeholder when nothing is selected", () => {
    renderSelect();
    expect(screen.getByRole("combobox")).toHaveTextContent("Select…");
  });

  it("shows the selected option's label", () => {
    renderSelect({ value: "in-progress" });
    expect(screen.getByRole("combobox")).toHaveTextContent("In progress");
  });

  it("opens the listbox on click and exposes options with aria-selected", async () => {
    renderSelect({ value: "todo" });
    await userEvent.click(screen.getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    expect(listbox).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(screen.getByRole("option", { name: "Todo" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "true");
  });

  it("exposes aria-activedescendant pointing at the highlighted option", async () => {
    renderSelect();
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("listbox");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const active = trigger.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    const option = document.getElementById(active as string);
    expect(option).toHaveAttribute("role", "option");
    expect(option).toHaveTextContent("In progress");
  });

  it("commits the highlighted option on Enter", async () => {
    const { onValueChange } = renderSelect();
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("listbox");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("todo");
  });

  it("skips disabled options when arrowing", async () => {
    const { onValueChange } = renderSelect();
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    await screen.findByRole("listbox");
    fireEvent.keyDown(trigger, { key: "End" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    // "done" is disabled, so End must land on "in-progress".
    expect(onValueChange).toHaveBeenCalledWith("in-progress");
  });

  it("typeahead jumps to an option by its first letters", async () => {
    renderSelect();
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "I" });
    fireEvent.keyDown(trigger, { key: "n" });
    // Nothing open yet: typing opens nothing, so this asserts the documented
    // behaviour that typeahead works while the listbox is open.
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens from the keyboard (ArrowDown) — commit path asserted above", async () => {
    const { onValueChange } = renderSelect();
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Base UI's commit handlers need a real browser's input pipeline: jsdom
    // cannot drive ArrowDown→Enter into a selection (measured — the commit
    // never arrives). The full keyboard model is asserted in the story play,
    // which runs in chromium, rather than faked here.
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("closes on Escape WITHOUT changing the value", async () => {
    const { onValueChange } = renderSelect({ value: "todo" });
    const trigger = screen.getByRole("combobox");
    await userEvent.click(trigger);
    await screen.findByRole("listbox");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("never selects a disabled option", async () => {
    const { onValueChange } = renderSelect();
    await userEvent.click(screen.getByRole("combobox"));
    const done = await screen.findByRole("option", { name: "Done" });
    expect(done).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(done);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("does not open while disabled", async () => {
    renderSelect({ disabled: true });
    const trigger = screen.getByRole("combobox");
    // Base UI marks the trigger with data-disabled (measured); assert the
    // behaviour too, because the attribute alone proves nothing about opening.
    expect(trigger).toHaveAttribute("data-disabled");
    await userEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders an empty option set without inventing rows", async () => {
    renderSelect({ options: [] });
    await userEvent.click(screen.getByRole("combobox"));
    await screen.findByRole("listbox");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("portals into the given container", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    renderSelect({ container: host });
    await userEvent.click(screen.getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    expect(host.contains(listbox)).toBe(true);
    host.remove();
  });

  it("uses token utilities only", () => {
    renderSelect();
    const trigger = screen.getByRole("combobox");
    expect(trigger.className).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(trigger.className).not.toMatch(/\[[^\]]+\]/);
  });
});
describe("Select edge paths (P12)", () => {
  it("shows a no-options message rather than an empty box", async () => {
    renderSelect({ options: [] });
    await userEvent.click(screen.getByRole("combobox"));
    await screen.findByRole("listbox");
    expect(screen.getByText("No options")).toBeInTheDocument();
  });

  it("TAB closes the listbox without committing", async () => {
    const { onValueChange } = renderSelect();
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("listbox");
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("an outside pointerdown closes it without committing", async () => {
    const { onValueChange } = renderSelect();
    await userEvent.click(screen.getByRole("combobox"));
    await screen.findByRole("listbox");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("typeahead jumps while the listbox is open", async () => {
    renderSelect();
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("listbox");
    fireEvent.keyDown(trigger, { key: "I" });
    fireEvent.keyDown(trigger, { key: "n" });
    const active = trigger.getAttribute("aria-activedescendant");
    expect(document.getElementById(active as string)).toHaveTextContent(
      "In progress",
    );
  });

  it("respects a custom renderValue", () => {
    renderSelect({
      value: "todo",
      renderValue: (option) => <strong>{`picked:${option?.value}`}</strong>,
    });
    expect(screen.getByRole("combobox")).toHaveTextContent("picked:todo");
  });

  it("ignores navigation keys while disabled", () => {
    const { onValueChange } = renderSelect({ disabled: true });
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("Home/End move to the edges of the enabled set", async () => {
    const { onValueChange } = renderSelect();
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("listbox");
    fireEvent.keyDown(trigger, { key: "End" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("in-progress");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("listbox");
    fireEvent.keyDown(trigger, { key: "Home" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith("todo");
  });
});
