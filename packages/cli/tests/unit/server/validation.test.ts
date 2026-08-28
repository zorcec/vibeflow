import { describe, it, expect } from "vitest";
import { isValidTaskId } from "../../../src/server/server.js";

describe("isValidTaskId", () => {
  it("accepts a 30-character hex string", () => {
    expect(isValidTaskId("a".repeat(30))).toBe(true);
    expect(isValidTaskId("0123456789abcdef".repeat(2).slice(0, 30))).toBe(true);
  });

  it("rejects non-hex characters", () => {
    expect(isValidTaskId("g".repeat(30))).toBe(false);
    expect(isValidTaskId("../etc/passwd")).toBe(false);
  });

  it("rejects wrong lengths", () => {
    expect(isValidTaskId("a".repeat(29))).toBe(false);
    expect(isValidTaskId("a".repeat(31))).toBe(false);
  });
});
