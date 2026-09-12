import { describe, it, expect, beforeEach } from "vitest";
import {
  THEMES,
  THEME_REGISTRY,
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  getThemeDefinition,
  isTheme,
  getStoredTheme,
  setStoredTheme,
  clearStoredTheme,
  resolveInitialTheme,
  applyTheme,
  applyInitialTheme,
} from "../theme";

/** Minimal in-memory Storage stub so tests never touch the real localStorage. */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe("theme tokens", () => {
  it("derives the known theme list from the registry, dark first", () => {
    expect(THEMES).toEqual([
      "dark",
      "light",
      "hc-dark",
      "rose-pine-dawn",
      "dracula",
      "gruvbox-dark",
    ]);
    expect(THEMES).toContain(DEFAULT_THEME);
  });
});

describe("theme registry", () => {
  it("lists each theme id exactly once", () => {
    const ids = THEME_REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(THEMES);
  });

  it("carries the display metadata every consumer reads", () => {
    for (const entry of THEME_REGISTRY) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(["dark", "light"]).toContain(entry.base);
      expect(entry.preview.length).toBeGreaterThanOrEqual(2);
      expect(entry.preview.length).toBeLessThanOrEqual(4);
      for (const swatch of entry.preview) {
        expect(swatch).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("resolves a definition for every registered theme", () => {
    for (const id of THEMES) {
      expect(getThemeDefinition(id).id).toBe(id);
    }
  });
});

describe("isTheme", () => {
  it("accepts every known theme", () => {
    for (const theme of THEMES) expect(isTheme(theme)).toBe(true);
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isTheme("sepia")).toBe(false);
    expect(isTheme("")).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(undefined)).toBe(false);
    expect(isTheme(42)).toBe(false);
    expect(isTheme({ theme: "dark" })).toBe(false);
  });
});

describe("getStoredTheme", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("returns null when nothing is stored", () => {
    expect(getStoredTheme(storage)).toBeNull();
  });

  it("returns a valid stored theme", () => {
    storage.setItem(THEME_STORAGE_KEY, "light");
    expect(getStoredTheme(storage)).toBe("light");
  });

  it("returns null for an invalid/stale stored value", () => {
    storage.setItem(THEME_STORAGE_KEY, "neon");
    expect(getStoredTheme(storage)).toBeNull();
  });

  it("is a no-op (null) without any storage", () => {
    expect(getStoredTheme(null)).toBeNull();
  });

  it("survives a storage that throws", () => {
    const hostile = {
      getItem() {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(getStoredTheme(hostile)).toBeNull();
  });
});

describe("setStoredTheme / clearStoredTheme", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("round-trips every known theme", () => {
    for (const theme of THEMES) {
      setStoredTheme(theme, storage);
      expect(storage.getItem(THEME_STORAGE_KEY)).toBe(theme);
      expect(getStoredTheme(storage)).toBe(theme);
    }
  });

  it("clears the stored preference", () => {
    setStoredTheme("hc-dark", storage);
    clearStoredTheme(storage);
    expect(getStoredTheme(storage)).toBeNull();
  });

  it("is a no-op without storage", () => {
    expect(() => setStoredTheme("light", null)).not.toThrow();
    expect(() => clearStoredTheme(null)).not.toThrow();
  });
});

describe("resolveInitialTheme", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("returns null when no explicit preference is stored (CSS fallback wins)", () => {
    expect(resolveInitialTheme(storage)).toBeNull();
  });

  it("returns the stored preference when present", () => {
    setStoredTheme("light", storage);
    expect(resolveInitialTheme(storage)).toBe("light");
  });
});

describe("applyTheme", () => {
  it("writes data-theme on the target element", () => {
    const el = document.createElement("html");
    applyTheme("light", el);
    expect(el.getAttribute("data-theme")).toBe("light");
  });

  it("removes data-theme when given null (restores the media fallback)", () => {
    const el = document.createElement("html");
    el.setAttribute("data-theme", "hc-dark");
    applyTheme(null, el);
    expect(el.hasAttribute("data-theme")).toBe(false);
  });

  it("defaults to <html> and is safe when there is no document", () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyTheme(null);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("applyInitialTheme", () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute("data-theme");
  });

  it("leaves <html> unthemed when no preference is stored", () => {
    const result = applyInitialTheme();
    expect(result).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("applies and returns a stored preference", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    const result = applyInitialTheme();
    expect(result).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("ignores an invalid stored preference", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "neon");
    const result = applyInitialTheme();
    expect(result).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
