// @vitest-environment jsdom
/**
 * Theme switcher (CLI kanban Settings modal).
 *
 * Locks the user-facing contract from task cd59c80a:
 *  - "System" is a real, selected option, distinct from "unset preference";
 *    choosing it CLEARS the stored key so themes.css' prefers-color-scheme
 *    fallback decides.
 *  - A concrete theme is applied + persisted immediately, through the shared
 *    THEME_STORAGE_KEY / resolver from @vibeflow-tools/ui/kanban (no private
 *    key, no re-implementation).
 *  - The control is a native radio group: arrow-key operable and announced as
 *    radios, with the media-query hint wired via aria-describedby.
 */
import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { THEME_STORAGE_KEY } from "@vibeflow-tools/ui/kanban";
import {
  THEME_PREFERENCES,
  ThemeSwitcher,
  applyThemePreference,
  readThemePreference,
} from "../../../src/client/kanban/components/ThemeSwitcher.js";

// React 18 warns about state updates outside act() unless this is set.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<ThemeSwitcher />);
  });
  return container;
}

function radios(): HTMLInputElement[] {
  return Array.from(
    container!.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  );
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
  document.documentElement.removeAttribute("data-theme");
});

describe("theme preference resolver", () => {
  it("reports 'system' when no preference is stored", () => {
    expect(readThemePreference()).toBe("system");
  });

  it("reports the stored theme when one is persisted", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(readThemePreference()).toBe("light");
  });

  it("applies and persists a concrete theme immediately", () => {
    applyThemePreference("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("clears the stored preference for 'system' so the media query decides", () => {
    applyThemePreference("dark");
    applyThemePreference("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("ThemeSwitcher", () => {
  it("offers System plus every registry theme as radios", () => {
    const el = mount();
    const expected = [
      "system",
      "dark",
      "light",
      "hc-dark",
      "rose-pine-dawn",
      "dracula",
      "gruvbox-dark",
    ];
    expect(THEME_PREFERENCES).toEqual(expected);
    const options = Array.from(
      el.querySelectorAll<HTMLElement>("[data-theme-option]"),
    ).map((tile) => tile.getAttribute("data-theme-option"));
    expect(options).toEqual(expected);
    expect(radios()).toHaveLength(expected.length);
    // One shared radio name => native arrow-key navigation inside the group.
    const names = new Set(radios().map((r) => r.name));
    expect(names.size).toBe(1);
    expect(el.querySelector("legend")?.textContent).toBe("Theme");
  });

  it("renders registry labels, descriptions and preview swatches", () => {
    const el = mount();
    // Every concrete theme is data-driven: label, hint and 4 swatches.
    for (const id of ["rose-pine-dawn", "dracula", "gruvbox-dark"]) {
      const tile = el.querySelector<HTMLElement>(
        `[data-theme-option="${id}"]`,
      )!;
      expect(tile.querySelector(".theme-option-label")?.textContent).toBeTruthy();
      expect(tile.querySelector(".theme-option-hint")?.textContent).toBeTruthy();
      expect(tile.querySelectorAll(".theme-option-swatch")).toHaveLength(4);
    }
    // System is not a registry theme, so it keeps the monitor glyph, no swatches.
    const system = el.querySelector<HTMLElement>('[data-theme-option="system"]')!;
    expect(system.querySelectorAll(".theme-option-swatch")).toHaveLength(0);
  });

  it("selects a curated registry theme without any component edit", () => {
    mount();
    act(() => {
      radios()
        .find((r) => r.value === "dracula")!
        .click();
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dracula");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dracula");
  });

  it("selects System by default and describes the system option", () => {
    const el = mount();
    const checked = radios().filter((r) => r.checked);
    expect(checked).toHaveLength(1);
    expect(checked[0].value).toBe("system");
    expect(
      el
        .querySelector('[data-selected="true"]')
        ?.getAttribute("data-theme-option"),
    ).toBe("system");
    const describedBy = checked[0].getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(el.querySelector(`[id="${describedBy}"]`)?.textContent).toMatch(
      /follows your OS/i,
    );
  });

  it("switches, applies and persists on click without a reload", () => {
    mount();
    const light = radios().find((r) => r.value === "light")!;
    act(() => {
      light.click();
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(
      radios()
        .filter((r) => r.checked)
        .map((r) => r.value),
    ).toEqual(["light"]);
    expect(
      container!
        .querySelector('[data-selected="true"]')
        ?.getAttribute("data-theme-option"),
    ).toBe("light");
  });

  it("selecting System clears the override that was set before it", () => {
    mount();
    act(() => {
      radios()
        .find((r) => r.value === "hc-dark")!
        .click();
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("hc-dark");
    act(() => {
      radios()
        .find((r) => r.value === "system")!
        .click();
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(
      radios()
        .filter((r) => r.checked)
        .map((r) => r.value),
    ).toEqual(["system"]);
  });

  it("shows the persisted choice when the modal is reopened", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "hc-dark");
    mount();
    expect(
      radios()
        .filter((r) => r.checked)
        .map((r) => r.value),
    ).toEqual(["hc-dark"]);
  });
});
