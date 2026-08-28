import { describe, it, expect } from "vitest";
import { classifyTaskUpdate } from "../../../src/commands/watch.js";

describe("classifyTaskUpdate", () => {
  it("classifies a previously unseen task as new", () => {
    expect(classifyTaskUpdate(undefined, "todo")).toBe("new");
    expect(classifyTaskUpdate(undefined, "backlog")).toBe("new");
    expect(classifyTaskUpdate(undefined, "in-progress")).toBe("new");
  });

  it("classifies a transition into todo as moved-to-todo", () => {
    expect(classifyTaskUpdate("backlog", "todo")).toBe("moved-to-todo");
    expect(classifyTaskUpdate("in-progress", "todo")).toBe("moved-to-todo");
    expect(classifyTaskUpdate("review", "todo")).toBe("moved-to-todo");
    expect(classifyTaskUpdate("done", "todo")).toBe("moved-to-todo");
  });

  it("does not classify a task already in todo as moved-to-todo", () => {
    expect(classifyTaskUpdate("todo", "todo")).toBeNull();
  });

  it("does not classify non-todo transitions (e.g. in-progress, review, done)", () => {
    expect(classifyTaskUpdate("todo", "in-progress")).toBeNull();
    expect(classifyTaskUpdate("in-progress", "review")).toBeNull();
    expect(classifyTaskUpdate("review", "done")).toBeNull();
    expect(classifyTaskUpdate("backlog", "in-progress")).toBeNull();
  });
});
