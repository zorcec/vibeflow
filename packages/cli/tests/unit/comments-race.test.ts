import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTask } from "../../src/core/tasks.js";
import { addComment, listComments } from "../../src/core/comments.js";

describe("addComment concurrent writes", () => {
  it("20 concurrent addComment calls all persist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comment-race-"));
    const task = createTask(dir, {
      title: "Race test",
      description: "",
      status: "todo",
      selector: "/",
    });

    const promises = Array.from({ length: 20 }, (_, i) =>
      addComment(dir, task.id, "user", `comment ${i}`),
    );

    const comments = await Promise.all(promises);
    expect(comments).toHaveLength(20);

    const stored = listComments(dir, task.id);
    expect(stored).toHaveLength(20);
  });
});
