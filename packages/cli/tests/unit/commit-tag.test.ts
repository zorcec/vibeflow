import { describe, it, expect } from "vitest";
import {
  COMMIT_TAG_PREFIX,
  LEGACY_COMMIT_TAG_PREFIX,
  formatCommitTag,
  parseCommitTag,
  hasCommitTag,
} from "../../src/core/commit-tag.js";

describe("commit-tag", () => {
  it("emits the vibeflow tag", () => {
    expect(formatCommitTag("abc123")).toBe("[vibeflow:abc123]");
    expect(COMMIT_TAG_PREFIX).toBe("vibeflow");
  });

  it("parses the current tag", () => {
    expect(parseCommitTag("feat: work [vibeflow:abc123]")).toBe("abc123");
  });

  it("still parses the legacy proto tag (back-compat for old commits)", () => {
    expect(LEGACY_COMMIT_TAG_PREFIX).toBe("proto");
    expect(parseCommitTag("feat: work [proto:abc123]")).toBe("abc123");
    expect(hasCommitTag("feat: work [proto:abc123]", "abc123")).toBe(true);
  });

  it("prefers the new tag when both are present", () => {
    expect(parseCommitTag("[proto:old] [vibeflow:new]")).toBe("new");
  });

  it("returns null for untagged messages", () => {
    expect(parseCommitTag("feat: work without a tag")).toBeNull();
    expect(hasCommitTag("feat: work without a tag", "abc123")).toBe(false);
  });

  it("hasCommitTag rejects other ids", () => {
    expect(hasCommitTag("feat: work [vibeflow:abc123]", "other")).toBe(false);
  });
});
