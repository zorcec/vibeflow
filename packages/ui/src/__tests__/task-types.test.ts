import { describe, expect, it } from "vitest";
import {
  LEGACY_TASK_TYPE_MAP,
  TASK_TYPE_FILTER_OPTIONS,
  canonicalTaskType,
  matchesTaskTypeFilter,
} from "../task-types";

describe("task type filter vocabulary (zbew735s)", () => {
  it("offers exactly the canonical three types", () => {
    expect(TASK_TYPE_FILTER_OPTIONS.map((o) => o.value)).toEqual([
      "Bug",
      "Task",
      "Research",
    ]);
  });

  it("carries a friendly label per type", () => {
    for (const opt of TASK_TYPE_FILTER_OPTIONS) {
      expect(typeof opt.label).toBe("string");
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it("documents the legacy map: Feature and Enhancement are Task", () => {
    expect(LEGACY_TASK_TYPE_MAP).toEqual({
      Feature: "Task",
      Enhancement: "Task",
    });
  });

  it("canonicalTaskType maps legacy aliases onto Task", () => {
    expect(canonicalTaskType("Feature")).toBe("Task");
    expect(canonicalTaskType("Enhancement")).toBe("Task");
    expect(canonicalTaskType("feature")).toBe("Task");
    expect(canonicalTaskType("ENHANCEMENT")).toBe("Task");
  });

  it("canonicalTaskType keeps canonical values (any casing)", () => {
    expect(canonicalTaskType("Bug")).toBe("Bug");
    expect(canonicalTaskType("bug")).toBe("Bug");
    expect(canonicalTaskType("Task")).toBe("Task");
    expect(canonicalTaskType("Research")).toBe("Research");
    expect(canonicalTaskType("research")).toBe("Research");
  });

  it("canonicalTaskType defaults a missing type to Task", () => {
    expect(canonicalTaskType(undefined)).toBe("Task");
    expect(canonicalTaskType(null)).toBe("Task");
    expect(canonicalTaskType("")).toBe("Task");
  });

  it("canonicalTaskType passes an unknown label through verbatim", () => {
    expect(canonicalTaskType("Chore")).toBe("Chore");
  });
});

describe("matchesTaskTypeFilter (zbew735s)", () => {
  it("a null filter matches everything, including legacy aliases", () => {
    expect(matchesTaskTypeFilter("Feature", null)).toBe(true);
    expect(matchesTaskTypeFilter("Bug", null)).toBe(true);
    expect(matchesTaskTypeFilter(undefined, null)).toBe(true);
  });

  it("filtering by Task returns tasks stored under its legacy aliases", () => {
    const board = ["Task", "Feature", "Enhancement", "Bug", "Research"];
    expect(board.filter((t) => matchesTaskTypeFilter(t, "Task"))).toEqual([
      "Task",
      "Feature",
      "Enhancement",
    ]);
  });

  it("legacy aliases do not leak into the other canonical filters", () => {
    expect(matchesTaskTypeFilter("Feature", "Bug")).toBe(false);
    expect(matchesTaskTypeFilter("Enhancement", "Research")).toBe(false);
    expect(matchesTaskTypeFilter("Bug", "Task")).toBe(false);
  });
});
