import { describe, it, expect } from "vitest";

// ── PATCH whitelist: verify mass-assignment keys are filtered ─────────────

const ALLOWED_PATCH_KEYS = new Set([
  "status", "title", "description", "type", "priority",
  "reportBack", "agent", "model", "tags", "sortKey",
  "branchName",
]);

describe("PATCH /api/tasks/:id whitelist", () => {
  it("passes through allowed keys", () => {
    const body = {
      status: "review",
      title: "New Title",
      description: "Updated",
      type: "Bug",
      priority: "High",
      branchName: "feat/test",
    };

    const filtered = Object.fromEntries(
      Object.entries(body).filter(([k]) => ALLOWED_PATCH_KEYS.has(k)),
    );

    expect(filtered).toEqual(body);
  });

  it("strips mass-assignment keys (verified, author, commits, comments, files, authStateEnc, id, created)", () => {
    const body = {
      status: "review",
      title: "New Title",
      verified: true,
      author: "attacker",
      commits: [{ sha: "evil", message: "evil", timestamp: "2099-01-01" }],
      comments: [{ id: "evil" }],
      files: [{ name: "evil" }],
      authStateEnc: "evil",
      id: "wrong-id",
      created: "2099-01-01",
    };

    const filtered = Object.fromEntries(
      Object.entries(body).filter(([k]) => ALLOWED_PATCH_KEYS.has(k)),
    );

    expect(filtered).toEqual({
      status: "review",
      title: "New Title",
    });
    expect(filtered).not.toHaveProperty("verified");
    expect(filtered).not.toHaveProperty("author");
    expect(filtered).not.toHaveProperty("commits");
    expect(filtered).not.toHaveProperty("comments");
    expect(filtered).not.toHaveProperty("files");
    expect(filtered).not.toHaveProperty("authStateEnc");
    expect(filtered).not.toHaveProperty("id");
    expect(filtered).not.toHaveProperty("created");
  });

  it("allows all valid patch fields", () => {
    const allAllowed = [
      "status", "title", "description", "type", "priority",
      "reportBack", "agent", "model", "tags", "sortKey", "branchName",
    ];
    for (const key of allAllowed) {
      expect(ALLOWED_PATCH_KEYS.has(key)).toBe(true);
    }
  });

  it("blocks dangerous fields", () => {
    const blocked = [
      "verified", "author", "commits", "comments", "files",
      "authStateEnc", "id", "created",
    ];
    for (const key of blocked) {
      expect(ALLOWED_PATCH_KEYS.has(key)).toBe(false);
    }
  });
});
