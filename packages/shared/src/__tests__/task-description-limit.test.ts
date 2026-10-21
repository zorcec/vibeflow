import { describe, expect, it } from "vitest";

import {
  TASK_DESCRIPTION_MAX,
  createTaskSchema,
  formatDescriptionTooLong,
  updateTaskSchema,
} from "../schemas";

/**
 * Regression guard for the description-limit unification: the web
 * create/update schemas and the overlay schema share ONE constant
 * (TASK_DESCRIPTION_MAX = 20,000). The overlay used to enforce half that
 * (max 5000) and the UI gave no readable error — a 20,001-char write must
 * now fail with a human sentence, not a bare BAD_REQUEST.
 */
describe("task description limit", () => {
  it("is a single shared constant of 20,000", () => {
    expect(TASK_DESCRIPTION_MAX).toBe(20_000);
  });

  it("accepts a description of exactly 20,000 chars on create and update", () => {
    const description = "x".repeat(20_000);
    expect(description).toHaveLength(TASK_DESCRIPTION_MAX);
    const created = createTaskSchema.safeParse({
      workspaceId: "ws",
      boardId: "board",
      title: "t",
      description,
    });
    expect(created.success).toBe(true);
    const updated = updateTaskSchema.safeParse({
      workspaceId: "ws",
      taskId: "task",
      patch: { description },
    });
    expect(updated.success).toBe(true);
  });

  it("rejects 20,001 chars on create and update, mappable to a readable message", () => {
    const description = "x".repeat(20_001);
    const created = createTaskSchema.safeParse({
      workspaceId: "ws",
      boardId: "board",
      title: "t",
      description,
    });
    expect(created.success).toBe(false);
    const updated = updateTaskSchema.safeParse({
      workspaceId: "ws",
      taskId: "task",
      patch: { description },
    });
    expect(updated.success).toBe(false);
    // The call-site mapping (overlay route, panel save guard) turns the
    // Zod too_big issue into this sentence — never a raw BAD_REQUEST.
    expect(formatDescriptionTooLong(description.length)).toBe(
      "Description is 20,001 characters; the limit is 20,000.",
    );
  });

  it("formats the owner-approved example sentence", () => {
    expect(formatDescriptionTooLong(21_431)).toBe(
      "Description is 21,431 characters; the limit is 20,000.",
    );
  });
});
