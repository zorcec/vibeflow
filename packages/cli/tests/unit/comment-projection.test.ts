import { describe, it, expect } from "vitest";
import { projectCommentText } from "../../src/core/comment-projection.js";
import { toSaasComment } from "../../src/saas/client.js";
import { toLocalTask } from "../../src/core/remote-task-store.js";

/**
 * Ticket 20c68ebb6db1ff68: the hosted record spells the comment field
 * `body` (the DB column) while the local record and the v0 contract spell
 * it `text`. One side of the mapping dropped the other spelling, so online
 * reads lost the prose. Both directions project through the single
 * `projectCommentText` helper — these tests pin that contract.
 */
describe("comment projection (ticket 20c68ebb6db1ff68)", () => {
  it("projects a hosted {body} row to the same text", () => {
    expect(
      projectCommentText({ id: "c1", author: "user", body: "hello" }),
    ).toBe("hello");
  });

  it("projects a contract/local {text} row to the same text", () => {
    expect(
      projectCommentText({ id: "c1", author: "user", text: "hello" }),
    ).toBe("hello");
  });

  it("keeps an empty body empty, never the string \"undefined\"", () => {
    expect(projectCommentText({ body: "" })).toBe("");
    expect(projectCommentText({ text: "" })).toBe("");
  });

  it("leaves a genuinely omitted field absent (undefined, not \"undefined\")", () => {
    expect(projectCommentText({})).toBeUndefined();
    expect(projectCommentText(null)).toBeUndefined();
    expect(projectCommentText(undefined)).toBeUndefined();
    expect(projectCommentText({ body: 42 })).toBeUndefined();
    expect(projectCommentText({})).not.toBe("undefined");
  });

  it("prefers the canonical text spelling when a row carries both", () => {
    expect(
      projectCommentText({ text: "display", body: "stored" }),
    ).toBe("display");
  });

  it("toSaasComment keeps a hosted {body} row (local {text} -> hosted {body} mirror)", () => {
    const mapped = toSaasComment(
      { id: "c1", author: "user", body: "hello", createdAt: "2026-01-01T00:00:00.000Z" },
      "task-1",
    );
    expect(mapped).not.toBeNull();
    expect(mapped?.body).toBe("hello");
  });

  it("toSaasComment keeps mapping contract {text} rows to hosted {body}", () => {
    const mapped = toSaasComment(
      { id: "c1", author: "user", text: "hello", createdAt: "2026-01-01T00:00:00.000Z" },
      "task-1",
    );
    expect(mapped?.body).toBe("hello");
  });

  it("toSaasComment drops a row with neither spelling instead of inventing one", () => {
    expect(
      toSaasComment(
        { id: "c1", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
        "task-1",
      ),
    ).toBeNull();
  });

  it("toLocalTask projects hosted {body} comments to local text", () => {
    const task = toLocalTask({
      id: "r1",
      title: "remote r1",
      description: "",
      status: "todo",
      boardId: "board-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      comments: [
        {
          id: "c1",
          taskId: "r1",
          body: "hello",
          authorId: "",
          author: "user",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(task?.comments?.[0]?.text).toBe("hello");
  });

  it("toLocalTask projects contract {text} comments to local text", () => {
    const task = toLocalTask({
      id: "r1",
      title: "remote r1",
      description: "",
      status: "todo",
      boardId: "board-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      comments: [
        {
          id: "c1",
          taskId: "r1",
          author: "user",
          text: "hello",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as never);
    expect(task?.comments?.[0]?.text).toBe("hello");
  });

  it("toLocalTask leaves a genuinely omitted comment field absent, not \"undefined\"", () => {
    const task = toLocalTask({
      id: "r1",
      title: "remote r1",
      description: "",
      status: "todo",
      boardId: "board-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      comments: [
        {
          id: "c1",
          taskId: "r1",
          authorId: "",
          author: "user",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as never);
    expect(task?.comments?.[0]?.text).not.toBe("undefined");
    expect(task?.comments?.[0]?.text).not.toBe("");
  });
});
