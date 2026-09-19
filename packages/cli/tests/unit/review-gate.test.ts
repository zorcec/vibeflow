import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkReviewTransition } from "../../src/core/review-gate.js";
import { getFilesDir } from "../../src/core/files.js";
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
  const dir = join(
    tmpdir(),
    `review-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTaskFile(
  dir: string,
  taskId: string,
  opts: {
    type?: string;
    verified?: boolean;
    selector?: string;
    url?: string;
  } = {},
) {
  const tasksDir = join(dir, ".vibeflow", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  // `verified` is tri-state: omit the key entirely when the caller does not
  // specify a verdict, so the store models "nothing assessed yet".
  const task: Record<string, unknown> = {
    id: taskId,
    title: "Test Task",
    description: "",
    status: "in-progress" as const,
    type: opts.type ?? "Task",
    priority: "Medium" as const,
    selector: opts.selector ?? "/",
    url: opts.url ?? undefined,
    created: new Date().toISOString(),
  };
  if (opts.verified !== undefined) task.verified = opts.verified;
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

  it("VERIFY_REQUIRED for an annotated task with no verdict on the transition", () => {
    // Nothing assessed yet (`verified` absent), so the gate needs the AGENT's
    // verdict and blocks.
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", commitMessage: "fix: x" },
      {
        projectDir: tmpDir,
        settings: makeSettings({ requireVerifyBeforeReview: true }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VERIFY_REQUIRED");
      // The error names all three verdict options so the agent can self-correct.
      expect(result.suggestion).toContain("--set-verify pass");
      expect(result.suggestion).toContain("--set-verify fail");
      expect(result.suggestion).toContain("--set-verify cannot");
    }
  });

  it("ALLOWS review when the transition carries the pass verdict", () => {
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", verifyVerdict: "pass" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(true);
  });

  it("ALLOWS review with a cannot verdict when it carries a reason", () => {
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      {
        comment: "done",
        verifyVerdict: "cannot",
        verifyReason: "no browser in this environment",
      },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(true);
  });

  it("REJECTS a cannot verdict without a reason (VERIFY_REASON_REQUIRED)", () => {
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", verifyVerdict: "cannot" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VERIFY_REASON_REQUIRED");
    }
  });

  it("REJECTS cannot without a reason even when the verify gate is OFF", () => {
    // "cannot" REQUIRES --verify-reason unconditionally — the reason is what
    // makes the verdict honest, so no setting can waive it.
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", verifyVerdict: "cannot" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: false,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VERIFY_REASON_REQUIRED");
    }
  });

  it("BLOCKS review when the store says verified:true but the transition carries no verdict", () => {
    // A stored flag is not the attestation — a stale `true` (written under the
    // old mechanical model, or by an earlier transition) must not carry a task
    // into review.
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
      verified: true,
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VERIFY_REQUIRED");
    }
  });

  it("BLOCKS review with a fail verdict — attested as NOT implemented correctly", () => {
    // The core new behaviour: `fail` is a completed verdict that the work is
    // WRONG, so it can never be submittable to review.
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", verifyVerdict: "fail" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VERIFY_FAILED_ATTESTED");
    }
  });

  it("BLOCKS review with a fail verdict for a task without URL/selector too", () => {
    createTaskFile(tmpDir, "task-123", { selector: "/", url: undefined });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", verifyVerdict: "fail" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VERIFY_FAILED_ATTESTED");
    }
  });

  it("BLOCKS review when the store carries verified:false and no attestation is given", () => {
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
      verified: false,
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VERIFY_FAILED_ATTESTED");
    }
  });

  it("VERIFY_REQUIRED for an annotated task with no baseline file (no silent skip)", () => {
    // The gate used to probe `<files>/baseline.json` and pass silently when it
    // was missing. It must not: an annotated task needs the attestation.
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
    });
    expect(
      existsSync(join(getFilesDir(tmpDir, "task-123"), "baseline.json")),
    ).toBe(false);

    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", commitMessage: "fix: x" },
      {
        projectDir: tmpDir,
        settings: makeSettings({ requireVerifyBeforeReview: true }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VERIFY_REQUIRED");
    }
  });

  it("ALLOWS review when a fresh pass verdict overrides a stored false", () => {
    // A stored `false` is the agent's verdict that the work was WRONG; a fresh
    // `pass` on THIS transition means the agent re-verified and the work now
    // satisfies the ticket, so the fresh verdict wins.
    createTaskFile(tmpDir, "task-123", {
      selector: ".submit-btn",
      url: "https://example.com",
      verified: false,
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", verifyVerdict: "pass" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(true);
  });

  it("passes verify gate for non-UI task (no selector/url)", () => {
    // Scope: the attestation gate covers ANNOTATED tasks only, because
    // `vibeflow verify` needs an annotation baseline to produce evidence.
    createTaskFile(tmpDir, "task-123", {
      selector: "/",
      url: undefined,
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
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

  // Regression for the reproduced case: Research task 9f6e1ac7 carries
  // url + selector '#main'. Before the fix the type-blind `isAnnotated` check
  // made the gate demand a verification verdict the task can never produce,
  // so the review transition was refused until the old bypass flag.
  it("does NOT demand an attestation for a Research task with url + selector (9f6e1ac7)", () => {
    createTaskFile(tmpDir, "9f6e1ac7", {
      type: "Research",
      selector: "#main",
      url: "https://example.com/report",
    });
    const filesDir = join(
      tmpDir,
      ".vibeflow",
      "tasks",
      "files",
      "9f6e1ac7",
    );
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "report.md"), "# Research Report");

    const result = checkReviewTransition(
      tmpDir,
      "9f6e1ac7",
      { comment: "added findings" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(true);
  });

  it("Research exemption is independent of the report gate: no .md yields RESEARCH_REPORT_REQUIRED, not VERIFY_REQUIRED", () => {
    createTaskFile(tmpDir, "task-123", {
      type: "Research",
      selector: "#main",
      url: "https://example.com/report",
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RESEARCH_REPORT_REQUIRED");
  });

  it("refuses LOUDLY when --set-verify pass is passed on a Research review transition", () => {
    createTaskFile(tmpDir, "task-123", {
      type: "Research",
      selector: "#main",
      url: "https://example.com/report",
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", verifyVerdict: "pass" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RESEARCH_VERIFY_NOT_ALLOWED");
    }
  });

  it("refuses LOUDLY when --set-verify fail is passed on a Research review transition", () => {
    createTaskFile(tmpDir, "task-123", {
      type: "Research",
      selector: "#main",
      url: "https://example.com/report",
    });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: "done", verifyVerdict: "fail" },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          requireVerifyBeforeReview: true,
          autoCommit: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RESEARCH_VERIFY_NOT_ALLOWED");
    }
  });

  it("passes gates in order: comment → commit → branch → verify → research", () => {
    createTaskFile(tmpDir, "task-123", { type: "Task" });
    const result = checkReviewTransition(
      tmpDir,
      "task-123",
      { comment: undefined },
      {
        projectDir: tmpDir,
        settings: makeSettings({
          autoCommit: true,
          createBranch: true,
          requireVerifyBeforeReview: true,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Comment is checked first
      expect(result.code).toBe("REVIEW_COMMENT_REQUIRED");
    }
  });
});
