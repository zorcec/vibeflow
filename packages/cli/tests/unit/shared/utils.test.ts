import { describe, it, expect } from "vitest";
import {
  generateId,
  userColor,
  buildRoomKey,
  parseRoomKey,
  slugify,
} from "@vibeflow-tools/shared";

describe("@vibeflow/shared utils", () => {
  describe("generateId", () => {
    it("returns a non-empty string", () => {
      const id = generateId();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    it("returns unique values", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()));
      expect(ids.size).toBe(100);
    });
  });

  describe("userColor", () => {
    it("returns an HSL string", () => {
      const color = userColor("user-123");
      expect(color).toMatch(/^hsl\(\d+, 70%, 55%\)$/);
    });

    it("is deterministic for the same userId", () => {
      expect(userColor("alice")).toBe(userColor("alice"));
    });

    it("differs for different userIds", () => {
      expect(userColor("alice")).not.toBe(userColor("bob"));
    });
  });

  describe("buildRoomKey / parseRoomKey", () => {
    it("builds a room key with correct format", () => {
      const key = buildRoomKey("ws1", "proj1", "board1");
      expect(key).toBe("workspace:ws1:project:proj1:board:board1");
    });

    it("round-trips correctly", () => {
      const key = buildRoomKey("ws1", "proj1", "board1");
      const parsed = parseRoomKey(key);
      expect(parsed).toEqual({
        workspaceId: "ws1",
        projectId: "proj1",
        boardId: "board1",
      });
    });

    it("returns null for invalid keys", () => {
      expect(parseRoomKey("invalid")).toBeNull();
      expect(parseRoomKey("workspace:a:project:b")).toBeNull();
      expect(parseRoomKey("foo:a:bar:b:baz:c")).toBeNull();
    });
  });

  describe("slugify", () => {
    it("lowercases and replaces spaces", () => {
      expect(slugify("My Project")).toBe("my-project");
    });

    it("removes special characters", () => {
      expect(slugify("Hello, World!")).toBe("hello-world");
    });

    it("trims leading and trailing hyphens", () => {
      expect(slugify("--test--")).toBe("test");
    });

    it("truncates to 100 characters", () => {
      const long = "a".repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(100);
    });
  });
});
