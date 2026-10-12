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

    it("quantizes to a fixed 12-hue palette (distinguishable cursors)", () => {
      const palette = new Set([
        0, 30, 55, 95, 140, 175, 200, 220, 250, 280, 310, 330,
      ]);
      const ids = Array.from({ length: 200 }, (_, i) => `user-${i}`);
      const hues = ids.map((id) => {
        const m = /^hsl\((\d+), 70%, 55%\)$/.exec(userColor(id));
        expect(m).not.toBeNull();
        return Number(m![1]);
      });
      for (const hue of hues) expect(palette.has(hue)).toBe(true);
      // Neighbours stay ≥20° apart, so two cursors never blur together.
      const sorted = [...palette].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i]!;
        const b = sorted[(i + 1) % sorted.length]!;
        expect((b - a + 360) % 360).toBeGreaterThanOrEqual(20);
      }
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
