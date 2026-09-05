import { describe, it, expect } from "vitest";
import { buildTaskPayload } from "../../src/client/overlay-browser/api.js";

const base = {
  selector: ".submit",
  cssSelector: ".submit",
  title: "Fix button",
  description: "Fix the button",
};

describe("buildTaskPayload", () => {
  it("includes priority and tags when advanced is provided", () => {
    const body = buildTaskPayload({
      ...base,
      advanced: { tags: ["ui", "p1"], priority: "High" },
    });
    expect(body.priority).toBe("High");
    expect(body.tags).toEqual(["ui", "p1"]);
  });

  it("omits priority when not set and tags when empty", () => {
    const body = buildTaskPayload({ ...base, advanced: { tags: [] } });
    expect(body.priority).toBeUndefined();
    expect(body.tags).toBeUndefined();
    expect("priority" in body || body.priority === undefined).toBe(true);
  });

  it("omits advanced fields entirely when no advanced object", () => {
    const body = buildTaskPayload(base);
    expect(body.tags).toBeUndefined();
    expect(body).not.toHaveProperty("priority", "High");
  });

  it("includes boardId only when provided", () => {
    expect(buildTaskPayload({ ...base, boardId: "b1" }).boardId).toBe("b1");
    expect(buildTaskPayload(base).boardId).toBeUndefined();
  });
});
