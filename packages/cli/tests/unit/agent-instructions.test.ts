import { describe, it, expect } from "vitest";
import { renderAgentInstructions } from "../../src/core/tasks.js";

describe("renderAgentInstructions", () => {
  it("includes workflow steps", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false });
    expect(text).toContain("vibeflow tasks --edit <id> --set-status in-progress");
    expect(text).toContain("<implement the change>");
  });

  it("includes auto-commit workflow when autoCommit is true", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false, autoCommit: true });
    expect(text).toContain("git add <files>");
    expect(text).toContain("--commit-message");
  });

  it("includes non-auto-commit workflow when autoCommit is false", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false, autoCommit: false });
    expect(text).toContain("vibeflow tasks --commit --task <id>");
  });

  it("includes research task rules when hasResearchTasks is true", () => {
    const text = renderAgentInstructions({ hasResearchTasks: true });
    expect(text).toContain("Research tasks: NEVER generate code");
    expect(text).toContain("--report-file");
  });

  it("includes bug task rules when hasBugTasks is true", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false, hasBugTasks: true });
    expect(text).toContain("Bug tasks: Include error logs");
  });

  it("includes settings flags", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      autoCommit: true,
      autoPush: true,
      autoComment: true,
      createBranch: true,
    });
    expect(text).toContain("Auto-commit ON");
    expect(text).toContain("Auto-push ON");
    expect(text).toContain("Auto-comment ON");
    expect(text).toContain("Create branch ON");
  });

  it("includes critical warnings", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false });
    expect(text).toContain("CRITICAL: NEVER edit .vibeflow/ task files directly.");
    expect(text).toContain("CRITICAL: NEVER set a task status to \"done\".");
  });

  it("includes auto-push setting when autoPush is true", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false, autoPush: true });
    expect(text).toContain("Auto-push ON");
  });

  it("excludes auto-push setting when autoPush is false", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false, autoPush: false });
    expect(text).not.toContain("Auto-push ON");
  });

  it("includes commit-message arg when autoCommit is true", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false, autoCommit: true });
    expect(text).toContain('--commit-message');
  });

  it("excludes commit-message arg when autoCommit is false", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false, autoCommit: false });
    expect(text).not.toContain('--commit-message');
  });

  it("includes comment format section when autoComment is true", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false, autoComment: true });
    expect(text).toContain("Comment format (--comment):");
    expect(text).toContain("Auto-comment ON");
  });

  it("excludes comment format section when autoComment is false", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false, autoComment: false });
    expect(text).not.toContain("Comment format (--comment):");
    expect(text).not.toContain("Auto-comment ON");
  });

  it("includes branch creation instructions when createBranch is true", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false, createBranch: true });
    expect(text).toContain("Create branch ON");
    expect(text).toContain("git checkout -b");
    expect(text).toContain("Create a branch FIRST");
  });

  it("excludes branch creation instructions when createBranch is false", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false, createBranch: false });
    expect(text).not.toContain("Create branch ON");
    expect(text).not.toContain("git checkout -b");
  });
});
