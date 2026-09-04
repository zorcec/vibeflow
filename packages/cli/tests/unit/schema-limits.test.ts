import { describe, it, expect } from "vitest";
import {
  createTaskSchema,
  updateTaskSchema,
  createCommentSchema,
  updateCommentSchema,
} from "@vibeflow-tools/shared";

describe("schema string-length limits", () => {
  describe("createTaskSchema", () => {
    const base = {
      workspaceId: "ws1",
      boardId: "b1",
      title: "Test",
    };

    it("accepts description at exactly 10 000 chars", () => {
      const input = { ...base, description: "a".repeat(10_000) };
      expect(createTaskSchema.safeParse(input).success).toBe(true);
    });

    it("rejects description exceeding 10 000 chars", () => {
      const input = { ...base, description: "a".repeat(10_001) };
      expect(createTaskSchema.safeParse(input).success).toBe(false);
    });

    it("accepts type at exactly 50 chars", () => {
      const input = { ...base, type: "a".repeat(50) };
      expect(createTaskSchema.safeParse(input).success).toBe(true);
    });

    it("rejects type exceeding 50 chars", () => {
      const input = { ...base, type: "a".repeat(51) };
      expect(createTaskSchema.safeParse(input).success).toBe(false);
    });

    it("accepts priority at exactly 50 chars", () => {
      const input = { ...base, priority: "a".repeat(50) };
      expect(createTaskSchema.safeParse(input).success).toBe(true);
    });

    it("rejects priority exceeding 50 chars", () => {
      const input = { ...base, priority: "a".repeat(51) };
      expect(createTaskSchema.safeParse(input).success).toBe(false);
    });

    it("accepts url at exactly 2 000 chars", () => {
      const input = {
        ...base,
        url: "https://example.com/" + "a".repeat(2000 - 20),
      };
      expect(createTaskSchema.safeParse(input).success).toBe(true);
    });

    it("rejects url exceeding 2 000 chars", () => {
      const input = {
        ...base,
        url: "https://example.com/" + "a".repeat(2000 - 20 + 1),
      };
      expect(createTaskSchema.safeParse(input).success).toBe(false);
    });

    it("accepts component at exactly 255 chars", () => {
      const input = { ...base, component: "a".repeat(255) };
      expect(createTaskSchema.safeParse(input).success).toBe(true);
    });

    it("rejects component exceeding 255 chars", () => {
      const input = { ...base, component: "a".repeat(256) };
      expect(createTaskSchema.safeParse(input).success).toBe(false);
    });
  });

  describe("updateTaskSchema.patch", () => {
    const base = {
      workspaceId: "ws1",
      taskId: "t1",
      patch: {} as Record<string, unknown>,
    };

    it("accepts description at exactly 10 000 chars", () => {
      const input = { ...base, patch: { description: "a".repeat(10_000) } };
      expect(updateTaskSchema.safeParse(input).success).toBe(true);
    });

    it("rejects description exceeding 10 000 chars", () => {
      const input = { ...base, patch: { description: "a".repeat(10_001) } };
      expect(updateTaskSchema.safeParse(input).success).toBe(false);
    });

    it("accepts commits array at 100 entries", () => {
      const commits = Array.from({ length: 100 }, (_, i) => ({
        sha: `sha${i}`,
        message: `msg${i}`,
        timestamp: "2026-01-01T00:00:00.000Z",
      }));
      const input = { ...base, patch: { commits } };
      expect(updateTaskSchema.safeParse(input).success).toBe(true);
    });

    it("rejects commits array exceeding 100 entries", () => {
      const commits = Array.from({ length: 101 }, (_, i) => ({
        sha: `sha${i}`,
        message: `msg${i}`,
        timestamp: "2026-01-01T00:00:00.000Z",
      }));
      const input = { ...base, patch: { commits } };
      expect(updateTaskSchema.safeParse(input).success).toBe(false);
    });

    it("accepts commit message at exactly 2 000 chars", () => {
      const input = {
        ...base,
        patch: {
          commits: [
            { sha: "abc", message: "a".repeat(2_000), timestamp: "2026-01-01" },
          ],
        },
      };
      expect(updateTaskSchema.safeParse(input).success).toBe(true);
    });

    it("rejects commit message exceeding 2 000 chars", () => {
      const input = {
        ...base,
        patch: {
          commits: [
            { sha: "abc", message: "a".repeat(2_001), timestamp: "2026-01-01" },
          ],
        },
      };
      expect(updateTaskSchema.safeParse(input).success).toBe(false);
    });
  });

  describe("createCommentSchema", () => {
    it("accepts body at exactly 10 000 chars", () => {
      const input = {
        workspaceId: "ws1",
        taskId: "t1",
        body: "a".repeat(10_000),
      };
      expect(createCommentSchema.safeParse(input).success).toBe(true);
    });

    it("rejects body exceeding 10 000 chars", () => {
      const input = {
        workspaceId: "ws1",
        taskId: "t1",
        body: "a".repeat(10_001),
      };
      expect(createCommentSchema.safeParse(input).success).toBe(false);
    });

    it("rejects empty body", () => {
      const input = { workspaceId: "ws1", taskId: "t1", body: "" };
      expect(createCommentSchema.safeParse(input).success).toBe(false);
    });
  });

  describe("updateCommentSchema", () => {
    it("accepts body at exactly 10 000 chars", () => {
      const input = {
        workspaceId: "ws1",
        commentId: "c1",
        body: "a".repeat(10_000),
      };
      expect(updateCommentSchema.safeParse(input).success).toBe(true);
    });

    it("rejects body exceeding 10 000 chars", () => {
      const input = {
        workspaceId: "ws1",
        commentId: "c1",
        body: "a".repeat(10_001),
      };
      expect(updateCommentSchema.safeParse(input).success).toBe(false);
    });
  });
});
