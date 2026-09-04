import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkReviewTransition } from "../../src/core/review-gate.js";
import type { ProtoSettings } from "../../src/core/settings.js";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

function makeSettings(overrides: Partial<ProtoSettings> = {}): ProtoSettings {
  return {
    autoComment: true,
    autoCommit: true,
    createBranch: false,
    requireVerifyBeforeReview: false,
    ...overrides,
  } as ProtoSettings;
}

function createTmpDir(): string {
  const dir = join(tmpdir(), `review-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTaskFile(dir: string, taskId: string, opts: { type?: string; verified?: boolean; selector?: string; url?: string } = {}) {
  const tasksDir = join(dir, ".vibeflow", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const task = {
    id: taskId,
    title: "Test Task",
    description: "",
    status: "in-progress" as const,
    type: opts.type ?? "Task",
    priority: "Medium" as const,
    selector: opts.selector ?? "/",
    url: opts.url ?? undefined,
    verified: opts.verified ?? false,
    created: new Date().toISOString(),
  };
  writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify(task));
  return task;
}

describe("checkReviewTransition", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns ok when all gates pass", () => {
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done" },
      { projectDir: tmpDir, settings: makeSettings({ autoCommit: false }) },
    );
    expect(result.ok).toBe(true);
  });

  it("REVIEW_COMMENT_REQUIRED when comment is missing", () => {
    createTaskFile(tmpDir, "task-123");
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: undefined },
      { projectDir: tmpDir, settings: makeSettings() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REVIEW_COMMENT_REQUIRED");
    }
  });

  it("REVIEW_COMMENT_REQUIRED when comment is empty", () => {
    createTaskFile(tmpDir, "task-123");
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "   " },
      { projectDir: tmpDir, settings: makeSettings() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REVIEW_COMMENT_REQUIRED");
    }
  });

  it("passes comment gate with valid comment", () => {
    createTaskFile(tmpDir, "task-123");
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "Fixed the thing" },
      { projectDir: tmpDir, settings: makeSettings({ autoCommit: false }) },
    );
    expect(result.ok).toBe(true);
  });

  it("COMMIT_MESSAGE_REQUIRED when autoCommit ON and no commitMessage", () => {
    createTaskFile(tmpDir, "task-123");
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", commitMessage: undefined },
      { projectDir: tmpDir, settings: makeSettings({ autoCommit: true }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("COMMIT_MESSAGE_REQUIRED");
    }
  });

  it("passes commit gate when autoCommit OFF", () => {
    createTaskFile(tmpDir, "task-123");
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done" },
      { projectDir: tmpDir, settings: makeSettings({ autoCommit: false }) },
    );
    expect(result.ok).toBe(true);
  });

  it("BRANCH_REQUIRED when createBranch ON and no branch", () => {
    createTaskFile(tmpDir, "task-123");
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", commitMessage: "fix: x", branch: undefined },
      { projectDir: tmpDir, settings: makeSettings({ createBranch: true }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BRANCH_REQUIRED");
    }
  });

  it("VERIFY_REQUIRED for UI task when requireVerifyBeforeReview ON", () => {
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
      verified: false,
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", commitMessage: "fix: x", skipVerify: false },
      { projectDir: tmpDir, settings: makeSettings({ requireVerifyBeforeReview: true }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VERIFY_REQUIRED");
    }
  });

  it("passes verify gate when skipVerify is true", () => {
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
      verified: false,
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", skipVerify: true },
      { projectDir: tmpDir, settings: makeSettings({ requireVerifyBeforeReview: true, autoCommit: false }) },
    );
    expect(result.ok).toBe(true);
  });

  it("passes verify gate for non-UI task (no selector/url)", () => {
    createTaskFile(tmpDir, "task-123", {
      selector: "/",
      url: undefined,
      verified: false,
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done" },
      { projectDir: tmpDir, settings: makeSettings({ requireVerifyBeforeReview: true, autoCommit: false }) },
    );
    expect(result.ok).toBe(true);
  });

  it("passes verify gate when task is already verified", () => {
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
      verified: true,
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done" },
      { projectDir: tmpDir, settings: makeSettings({ requireVerifyBeforeReview: true, autoCommit: false }) },
    );
    expect(result.ok).toBe(true);
  });

  it("RESEARCH_REPORT_REQUIRED for Research task with no .md files", () => {
    createTaskFile(tmpDir, "task-123", { type: "Research" });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done" },
      { projectDir: tmpDir, settings: makeSettings({ autoCommit: false }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RESEARCH_REPORT_REQUIRED");
    }
  });

  it("passes research gate when .md file is attached", () => {
    createTaskFile(tmpDir, "task-123", { type: "Research" });
    // Create a file in the task's files directory
    const filesDir = join(tmpDir, ".vibeflow", "tasks", "files", "task-123");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "report.md"), "# Research Report");
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done" },
      { projectDir: tmpDir, settings: makeSettings({ autoCommit: false }) },
    );
    expect(result.ok).toBe(true);
  });

  it("passes gates in order: comment → commit → branch → verify → research", () => {
    createTaskFile(tmpDir, "task-123", { type: "Task" });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: undefined },
      { projectDir: tmpDir, settings: makeSettings({ autoCommit: true, createBranch: true, requireVerifyBeforeReview: true }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Comment is checked first
      expect(result.code).toBe("REVIEW_COMMENT_REQUIRED");
    }
  });
});
