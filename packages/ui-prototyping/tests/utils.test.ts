import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  encodeUrlKey,
  readVariantFromUrl,
  writeVariantToUrl,
  removeVariantFromUrl,
  readVariantFromStorage,
  writeVariantToStorage,
  removeVariantFromStorage,
  writeUiVisibleToStorage,
  readUiVisibleFromStorage,
  resolveActiveVariant,
} from "../src/utils.js";

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

describe("encodeUrlKey", () => {
  it("encodes scope name as vf[name] format", () => {
    expect(encodeUrlKey("TaskCard")).toBe("vf[TaskCard]");
  });

  it("handles names with spaces", () => {
    expect(encodeUrlKey("My Component")).toBe("vf[My Component]");
  });
});

describe("readVariantFromUrl", () => {
  beforeEach(() => {
    // jsdom starts with empty URL; set a baseline
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/"),
    });
  });

  it("returns null when no matching param", () => {
    expect(readVariantFromUrl("TaskCard")).toBeNull();
  });

  it("returns the variant value when param present", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/?vf%5BTaskCard%5D=minimal"),
    });
    expect(readVariantFromUrl("TaskCard")).toBe("minimal");
  });

  it("returns null for different scope", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/?vf%5BKanban%5D=swimlane"),
    });
    expect(readVariantFromUrl("TaskCard")).toBeNull();
  });
});

describe("writeVariantToUrl / removeVariantFromUrl", () => {
  let pushStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/"),
    });
    pushStateSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  });

  afterEach(() => {
    pushStateSpy.mockRestore();
  });

  it("calls pushState with encoded URL param", () => {
    writeVariantToUrl("TaskCard", "minimal");
    expect(pushStateSpy).toHaveBeenCalledOnce();
    const url = pushStateSpy.mock.calls[0]![2] as string;
    expect(url).toContain("vf%5BTaskCard%5D=minimal");
  });

  it("removeVariantFromUrl calls pushState without the param", () => {
    removeVariantFromUrl("TaskCard");
    expect(pushStateSpy).toHaveBeenCalledOnce();
    const url = pushStateSpy.mock.calls[0]![2] as string;
    expect(url).not.toContain("TaskCard");
  });
});

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

describe("localStorage helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("writeVariantToStorage / readVariantFromStorage round-trip", () => {
    writeVariantToStorage("KanbanBoard", "swimlane");
    expect(readVariantFromStorage("KanbanBoard")).toBe("swimlane");
  });

  it("readVariantFromStorage returns null when not set", () => {
    expect(readVariantFromStorage("Unknown")).toBeNull();
  });

  it("removeVariantFromStorage clears the key", () => {
    writeVariantToStorage("KanbanBoard", "swimlane");
    removeVariantFromStorage("KanbanBoard");
    expect(readVariantFromStorage("KanbanBoard")).toBeNull();
  });

  it("writeVariantToStorage overwrites existing value", () => {
    writeVariantToStorage("Scope", "a");
    writeVariantToStorage("Scope", "b");
    expect(readVariantFromStorage("Scope")).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// UI visible persistence
// ---------------------------------------------------------------------------

describe("UI visible storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when not set", () => {
    expect(readUiVisibleFromStorage()).toBeNull();
  });

  it("persists true", () => {
    writeUiVisibleToStorage(true);
    expect(readUiVisibleFromStorage()).toBe(true);
  });

  it("persists false", () => {
    writeUiVisibleToStorage(false);
    expect(readUiVisibleFromStorage()).toBe(false);
  });

  it("overrides previous value", () => {
    writeUiVisibleToStorage(true);
    writeUiVisibleToStorage(false);
    expect(readUiVisibleFromStorage()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveActiveVariant
// ---------------------------------------------------------------------------

describe("resolveActiveVariant", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/"),
    });
  });

  it("returns default key when nothing set", () => {
    expect(resolveActiveVariant("Scope", ["default", "minimal"], "default")).toBe(
      "default",
    );
  });

  it("prefers localStorage over default", () => {
    writeVariantToStorage("Scope", "minimal");
    expect(
      resolveActiveVariant("Scope", ["default", "minimal"], "default"),
    ).toBe("minimal");
  });

  it("prefers URL over localStorage", () => {
    writeVariantToStorage("Scope", "minimal");
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/?vf%5BScope%5D=detailed"),
    });
    expect(
      resolveActiveVariant("Scope", ["default", "minimal", "detailed"], "default"),
    ).toBe("detailed");
  });

  it("ignores URL value that is not in variantKeys", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/?vf%5BScope%5D=nonexistent"),
    });
    expect(
      resolveActiveVariant("Scope", ["default", "minimal"], "default"),
    ).toBe("default");
  });

  it("ignores localStorage value that is not in variantKeys", () => {
    writeVariantToStorage("Scope", "nonexistent");
    expect(
      resolveActiveVariant("Scope", ["default", "minimal"], "default"),
    ).toBe("default");
  });
});
