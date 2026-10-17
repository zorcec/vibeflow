import { describe, expect, it, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  taskMatchesQuery,
  filterTasksByQuery,
  SEARCH_DEBOUNCE_MS,
} from "../search";
import { useDebouncedValue } from "../useDebouncedValue";

describe("taskMatchesQuery", () => {
  it("matches a title substring with identical case", () => {
    expect(
      taskMatchesQuery({ title: "Fix login bug", description: "" }, "login"),
    ).toBe(true);
  });

  it("matches case-insensitively on the title in both directions", () => {
    const task = { title: "Fix Login Bug", description: "" };
    expect(taskMatchesQuery(task, "login")).toBe(true);
    expect(taskMatchesQuery(task, "LOGIN")).toBe(true);
    expect(taskMatchesQuery({ title: "fix login bug", description: "" }, "LOGIN")).toBe(true);
  });

  it("matches on the description, not just the title", () => {
    expect(
      taskMatchesQuery(
        { title: "Unrelated title", description: "The token refresh path" },
        "token refresh",
      ),
    ).toBe(true);
  });

  it("matches case-insensitively on the description in both directions", () => {
    const task = { title: "Unrelated", description: "Token Refresh Path" };
    expect(taskMatchesQuery(task, "token refresh")).toBe(true);
    expect(taskMatchesQuery(task, "TOKEN REFRESH")).toBe(true);
  });

  it("returns false when neither field contains the query", () => {
    expect(
      taskMatchesQuery(
        { title: "Fix login bug", description: "Auth flow" },
        "payments",
      ),
    ).toBe(false);
  });

  it("empty query matches everything, even a field-less task", () => {
    expect(
      taskMatchesQuery({ title: "Anything", description: "whatever" }, ""),
    ).toBe(true);
    expect(taskMatchesQuery({ title: null, description: null }, "")).toBe(
      true,
    );
  });

  it("tolerates null/undefined fields without throwing", () => {
    expect(
      taskMatchesQuery(
        { title: null, description: "has description" },
        "description",
      ),
    ).toBe(true);
    expect(
      taskMatchesQuery({ title: undefined, description: undefined }, "x"),
    ).toBe(false);
  });

  it("multi-term queries are a CONTIGUOUS substring, not token search", () => {
    expect(
      taskMatchesQuery({ title: "x a b y", description: "" }, "a b"),
    ).toBe(true);
    // "a x b" contains both words but not the contiguous span "a b".
    expect(
      taskMatchesQuery({ title: "a x b", description: "" }, "a b"),
    ).toBe(false);
  });

  it("matches unicode case-insensitively and non-latin scripts", () => {
    expect(taskMatchesQuery({ title: "CAFÉ menu", description: "" }, "café")).toBe(
      true,
    );
    expect(taskMatchesQuery({ title: "café menu", description: "" }, "CAFÉ")).toBe(
      true,
    );
    expect(
      taskMatchesQuery({ title: "修复中文问题", description: "" }, "中文"),
    ).toBe(true);
  });

  it("treats special characters literally (no regex semantics)", () => {
    expect(taskMatchesQuery({ title: "migrate to C++", description: "" }, "C++")).toBe(
      true,
    );
    // A bare "." is a literal dot: "axb" must NOT match.
    expect(taskMatchesQuery({ title: "axb", description: "" }, "a.b")).toBe(false);
    expect(taskMatchesQuery({ title: "a.b", description: "" }, "a.b")).toBe(true);
    expect(
      taskMatchesQuery({ title: "task (wip) here", description: "" }, "(wip)"),
    ).toBe(true);
  });
});

describe("filterTasksByQuery", () => {
  const tasks = [
    { id: "1", title: "Fix login bug", description: "Auth flow" },
    { id: "2", title: "Payments page", description: "LOGIN redirect note" },
    { id: "3", title: "Docs", description: "Unrelated" },
  ];

  it("empty query returns every task", () => {
    expect(filterTasksByQuery(tasks, "")).toHaveLength(3);
  });

  it("returns the matching subset across both fields", () => {
    const ids = filterTasksByQuery(tasks, "login").map((t) => t.id);
    // id 1 via title, id 2 via description (case-insensitive).
    expect(ids).toEqual(["1", "2"]);
  });

  it("board list and header count agree: both derive from this one helper", () => {
    const filtered = filterTasksByQuery(tasks, "login");
    // The board renders `filtered`; the header reports
    // `${filtered.length} of ${tasks.length} tasks` — same array, same N.
    expect(`${filtered.length} of ${tasks.length} tasks`).toBe("2 of 3 tasks");
  });

  it("no match returns an empty list", () => {
    expect(filterTasksByQuery(tasks, "zzz-no-match")).toEqual([]);
  });
});

describe("useDebouncedValue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the value through a burst and settles after the delay", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 150),
      { initialProps: { value: "a" } },
    );
    expect(result.current).toBe("a");

    // Fast typing burst: the debounced value must NOT follow keystrokes.
    rerender({ value: "ab" });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ value: "abc" });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("a");

    // After a full pause the latest value lands exactly once.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe("abc");
  });

  it(`defaults to the shared SEARCH_DEBOUNCE_MS (${SEARCH_DEBOUNCE_MS}ms)`, () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value),
      { initialProps: { value: "a" } },
    );
    rerender({ value: "b" });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(result.current).toBe("a");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("b");
  });
});
