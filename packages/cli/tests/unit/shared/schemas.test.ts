import { describe, it, expect } from "vitest";
import {
  createWorkspaceSchema,
  createProjectSchema,
  createTaskSchema,
  updateTaskSchema,
  deleteTaskSchema,
  listTasksSchema,
  createCommentSchema,
  deviceInitResponseSchema,
  devicePollRequestSchema,
  devicePollResponseSchema,
} from "@vibeflow-tools/shared";

describe("@vibeflow/shared schemas", () => {
  describe("createWorkspaceSchema", () => {
    it("accepts valid input", () => {
      const result = createWorkspaceSchema.safeParse({
        name: "My Workspace",
        slug: "my-workspace",
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty name", () => {
      const result = createWorkspaceSchema.safeParse({
        name: "",
        slug: "my-workspace",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid slug with uppercase", () => {
      const result = createWorkspaceSchema.safeParse({
        name: "Test",
        slug: "MyWorkspace",
      });
      expect(result.success).toBe(false);
    });

    it("rejects slug with spaces", () => {
      const result = createWorkspaceSchema.safeParse({
        name: "Test",
        slug: "my workspace",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("createTaskSchema", () => {
    it("accepts valid input with defaults", () => {
      const result = createTaskSchema.safeParse({
        workspaceId: "ws1",
        boardId: "b1",
        title: "Test task",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("todo");
      }
    });

    it("accepts all valid statuses", () => {
      for (const status of ["todo", "in_progress", "done", "cancelled"]) {
        const result = createTaskSchema.safeParse({
          workspaceId: "ws1",
          boardId: "b1",
          title: "Test",
          status,
        });
        expect(result.success).toBe(true);
      }
    });

    it("rejects invalid status", () => {
      const result = createTaskSchema.safeParse({
        workspaceId: "ws1",
        boardId: "b1",
        title: "Test",
        status: "invalid_status",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty title", () => {
      const result = createTaskSchema.safeParse({
        workspaceId: "ws1",
        boardId: "b1",
        title: "",
      });
      expect(result.success).toBe(false);
    });

    it("rejects title exceeding 255 chars", () => {
      const result = createTaskSchema.safeParse({
        workspaceId: "ws1",
        boardId: "b1",
        title: "x".repeat(256),
      });
      expect(result.success).toBe(false);
    });
  });

  describe("updateTaskSchema", () => {
    it("accepts partial update", () => {
      const result = updateTaskSchema.safeParse({
        workspaceId: "ws1",
        taskId: "t1",
        patch: { title: "Updated" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts empty patch", () => {
      const result = updateTaskSchema.safeParse({
        workspaceId: "ws1",
        taskId: "t1",
        patch: {},
      });
      expect(result.success).toBe(true);
    });
  });

  describe("deleteTaskSchema", () => {
    it("requires workspaceId and taskId", () => {
      expect(
        deleteTaskSchema.safeParse({ workspaceId: "ws1", taskId: "t1" })
          .success,
      ).toBe(true);
      expect(
        deleteTaskSchema.safeParse({ workspaceId: "ws1" }).success,
      ).toBe(false);
    });
  });

  describe("listTasksSchema", () => {
    it("requires workspaceId and boardId", () => {
      expect(
        listTasksSchema.safeParse({ workspaceId: "ws1", boardId: "b1" })
          .success,
      ).toBe(true);
    });
  });

  describe("createCommentSchema", () => {
    it("accepts valid input", () => {
      const result = createCommentSchema.safeParse({
        workspaceId: "ws1",
        taskId: "t1",
        body: "Hello world",
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty body", () => {
      const result = createCommentSchema.safeParse({
        workspaceId: "ws1",
        taskId: "t1",
        body: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("device auth schemas", () => {
    it("validates device init response", () => {
      const result = deviceInitResponseSchema.safeParse({
        deviceCode: "abc123",
        userCode: "XY1234",
        verificationUrl: "http://localhost:3000/cli/verify?code=XY1234",
        expiresIn: 600,
      });
      expect(result.success).toBe(true);
    });

    it("validates device poll request", () => {
      expect(
        devicePollRequestSchema.safeParse({ deviceCode: "abc" }).success,
      ).toBe(true);
      expect(
        devicePollRequestSchema.safeParse({ deviceCode: "" }).success,
      ).toBe(false);
    });

    it("validates device poll response - pending", () => {
      const result = devicePollResponseSchema.safeParse({ pending: true });
      expect(result.success).toBe(true);
    });

    it("validates device poll response - token", () => {
      const result = devicePollResponseSchema.safeParse({
        token: "tok_abc123",
      });
      expect(result.success).toBe(true);
    });

    it("validates device poll response - expired", () => {
      const result = devicePollResponseSchema.safeParse({ expired: true });
      expect(result.success).toBe(true);
    });
  });
});
