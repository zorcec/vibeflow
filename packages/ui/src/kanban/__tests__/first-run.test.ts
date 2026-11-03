import { describe, it, expect, vi } from "vitest";
import {
  KANBAN_ONBOARDED_KEY,
  markOnboarded,
  shouldAutoOpenSettings,
  type OnboardedStorage,
} from "../first-run";

function memoryStorage(seed?: Record<string, string>): OnboardedStorage & {
  raw: Record<string, string>;
} {
  const raw: Record<string, string> = { ...(seed ?? {}) };
  return {
    raw,
    getItem: (k: string) => (k in raw ? raw[k] : null),
    setItem: (k: string, v: string) => {
      raw[k] = v;
    },
  };
}

describe("first-run onboarding (eajggnmjdyq226kzfn7yk3mw)", () => {
  it("auto-opens on an empty board with no flag set", () => {
    expect(
      shouldAutoOpenSettings(memoryStorage(), {
        isLoading: false,
        taskCount: 0,
        settingsOpen: false,
      }),
    ).toBe(true);
  });

  it("stays closed once the flag is set (never re-opens)", () => {
    const storage = memoryStorage({ [KANBAN_ONBOARDED_KEY]: "1" });
    expect(
      shouldAutoOpenSettings(storage, {
        isLoading: false,
        taskCount: 0,
        settingsOpen: false,
      }),
    ).toBe(false);
  });

  it("stays closed when tasks are present", () => {
    expect(
      shouldAutoOpenSettings(memoryStorage(), {
        isLoading: false,
        taskCount: 3,
        settingsOpen: false,
      }),
    ).toBe(false);
  });

  it("stays closed while the initial load is in flight", () => {
    expect(
      shouldAutoOpenSettings(memoryStorage(), {
        isLoading: true,
        taskCount: 0,
        settingsOpen: false,
      }),
    ).toBe(false);
  });

  it("stays closed when settings is already open", () => {
    expect(
      shouldAutoOpenSettings(memoryStorage(), {
        isLoading: false,
        taskCount: 0,
        settingsOpen: true,
      }),
    ).toBe(false);
  });

  it("markOnboarded records the flag so the next visit stays closed", () => {
    const storage = memoryStorage();
    markOnboarded(storage);
    expect(storage.raw[KANBAN_ONBOARDED_KEY]).toBe("1");
    expect(
      shouldAutoOpenSettings(storage, {
        isLoading: false,
        taskCount: 0,
        settingsOpen: false,
      }),
    ).toBe(false);
  });

  it("survives unavailable storage without throwing", () => {
    const throwing: OnboardedStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() =>
      shouldAutoOpenSettings(throwing, {
        isLoading: false,
        taskCount: 0,
        settingsOpen: false,
      }),
    ).not.toThrow();
    expect(() => markOnboarded(throwing)).not.toThrow();
    expect(() =>
      shouldAutoOpenSettings(null, {
        isLoading: false,
        taskCount: 0,
        settingsOpen: false,
      }),
    ).not.toThrow();
  });

  it("uses the exact localStorage key the board writes", () => {
    const setItem = vi.fn();
    markOnboarded({ getItem: () => null, setItem });
    expect(setItem).toHaveBeenCalledWith(KANBAN_ONBOARDED_KEY, "1");
    expect(KANBAN_ONBOARDED_KEY).toBe("vibeflow.kanban.onboarded");
  });
});
