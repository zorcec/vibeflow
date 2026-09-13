// @vitest-environment jsdom
/**
 * Settings modal — the Theme tab's Cancel is a real undo.
 *
 * The Theme tab used to apply AND persist a theme the moment it was picked,
 * while the modal footer still offered Cancel/Apply, so Cancel left the theme
 * changed. It now stages a DOM-only preview: Apply commits the staged theme,
 * and any other dismissal (Cancel, X, Escape, backdrop) rewinds the DOM and
 * the stored preference to the value the modal OPENED with.
 *
 * These tests drive the real SettingsModal + ThemeSwitcher pair end to end, so
 * they fail if either half of the contract regresses: the switcher staging its
 * choice, or the modal signalling dismiss/apply.
 */
import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { SettingsModal, THEME_STORAGE_KEY } from "@vibeflow-tools/ui/kanban";
import {
  ThemeSwitcher,
  themeSwitcherTab,
} from "../../../src/client/kanban/components/ThemeSwitcher.js";

// React 18 warns about state updates outside act() unless this is set.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let setOpen: ((open: boolean) => void) | null = null;

/** Mirrors the CLI App: open state owned above, modal closed via onClose. */
function Host() {
  const [open, setOpenState] = React.useState(true);
  setOpen = setOpenState;
  return (
    <SettingsModal
      open={open}
      visibleCols={["todo", "in-progress", "review"]}
      settings={{}}
      appearance={(slot) => <ThemeSwitcher slot={slot} />}
      appearanceTab={themeSwitcherTab}
      onClose={() => setOpenState(false)}
      onSave={() => {}}
    />
  );
}

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Host />));
}

function reopen(): void {
  act(() => setOpen?.(true));
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (el) => el.textContent === text,
  );
  if (!button) throw new Error(`No button labelled "${text}"`);
  return button;
}

function clickThemeTab(): void {
  act(() => buttonByText("Theme").click());
}

function selectTheme(value: string): void {
  const radio = document.querySelector<HTMLInputElement>(
    `input[type="radio"][value="${value}"]`,
  );
  if (!radio) throw new Error(`No theme radio "${value}"`);
  act(() => radio.click());
}

function click(id: string): void {
  const el = document.getElementById(id);
  if (!el) throw new Error(`No element #${id}`);
  act(() => (el as HTMLButtonElement).click());
}

function appliedTheme(): string | null {
  return document.documentElement.getAttribute("data-theme");
}

function storedTheme(): string | null {
  return window.localStorage.getItem(THEME_STORAGE_KEY);
}

function checkedTheme(): string | null {
  return (
    document.querySelector<HTMLInputElement>('input[type="radio"]:checked')
      ?.value ?? null
  );
}

/** Seed both the stored preference and the DOM, as a real boot would. */
function seed(theme: string): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  document.documentElement.setAttribute("data-theme", theme);
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  setOpen = null;
  document.documentElement.removeAttribute("data-theme");
});

describe("Settings modal — Theme tab Cancel/Apply", () => {
  it("Cancel rewinds a changed theme to the opening value (DOM + storage)", () => {
    seed("dark");
    mount();
    clickThemeTab();

    selectTheme("light");
    // Live preview: the DOM already shows the staged theme, storage is untouched.
    expect(appliedTheme()).toBe("light");
    expect(storedTheme()).toBe("dark");

    click("settings-cancel");
    expect(appliedTheme()).toBe("dark");
    expect(storedTheme()).toBe("dark");
  });

  it("Apply commits a changed theme", () => {
    seed("dark");
    mount();
    clickThemeTab();

    selectTheme("light");
    expect(appliedTheme()).toBe("light");
    expect(storedTheme()).toBe("dark");

    click("settings-apply");
    expect(appliedTheme()).toBe("light");
    expect(storedTheme()).toBe("light");
  });

  it("Cancel with no change is a no-op", () => {
    seed("hc-dark");
    mount();
    clickThemeTab();
    expect(checkedTheme()).toBe("hc-dark");

    click("settings-cancel");
    expect(appliedTheme()).toBe("hc-dark");
    expect(storedTheme()).toBe("hc-dark");
  });

  it("reopening after a Cancel shows the reverted theme selected", () => {
    seed("dark");
    mount();
    clickThemeTab();
    selectTheme("light");
    click("settings-cancel"); // closes

    reopen();
    clickThemeTab();
    expect(checkedTheme()).toBe("dark");
    expect(
      document
        .querySelector('[data-selected="true"]')
        ?.getAttribute("data-theme-option"),
    ).toBe("dark");
  });

  it("closing with the X rewinds like Cancel", () => {
    seed("dark");
    mount();
    clickThemeTab();
    selectTheme("light");

    click("settings-close");
    expect(appliedTheme()).toBe("dark");
    expect(storedTheme()).toBe("dark");
  });

  it("System stages a DOM-only preview and commits by clearing the key", () => {
    seed("dark");
    mount();
    clickThemeTab();

    selectTheme("system");
    expect(appliedTheme()).toBeNull();
    expect(storedTheme()).toBe("dark");

    click("settings-apply");
    expect(appliedTheme()).toBeNull();
    expect(storedTheme()).toBeNull();
  });
});
