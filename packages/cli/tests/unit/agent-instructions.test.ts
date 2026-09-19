import { describe, it, expect } from "vitest";
import { renderAgentInstructions } from "../../src/core/tasks.js";

describe("renderAgentInstructions", () => {
  it("includes workflow steps", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false });
    expect(text).toContain(
      "vibeflow tasks --edit <id> --set-status in-progress",
    );
    expect(text).toContain("<implement the change>");
  });

  it("includes --next auto-claim command in discover section", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false });
    expect(text).toContain("Auto-claim: vibeflow tasks --next");
  });

  it("includes auto-commit workflow when autoCommit is true", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      autoCommit: true,
    });
    expect(text).toContain("git add <files>");
    expect(text).toContain("--commit-message");
  });

  it("includes non-auto-commit workflow when autoCommit is false", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      autoCommit: false,
    });
    expect(text).toContain("vibeflow tasks --commit --task <id>");
  });

  it("includes research task rules when hasResearchTasks is true", () => {
    const text = renderAgentInstructions({ hasResearchTasks: true });
    expect(text).toContain("Research tasks: NEVER generate code");
    expect(text).toContain("--report-file");
    expect(text).toContain("Create the report file locally first");
    expect(text).toContain(
      "saved next to the task and deleted from the original path",
    );
    expect(text).toContain("findings, options considered");
  });

  it("includes blocked task escape hatch", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false });
    expect(text).toContain("BLOCKED?");
    expect(text).toContain("Blocked: <reason>");
    expect(text).toContain("vibeflow tasks --next");
    expect(text).toContain("Do not guess at unclear requirements");
  });

  it("includes bug task rules when hasBugTasks is true", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      hasBugTasks: true,
    });
    expect(text).toContain("Bug tasks: Reproduce the bug first");
    expect(text).toContain("· Symptom:");
    expect(text).toContain("· Root cause:");
    expect(text).toContain("· Evidence:");
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
    expect(text).toContain(
      "CRITICAL: NEVER edit .vibeflow/ task files directly.",
    );
    expect(text).toContain('CRITICAL: NEVER set a task status to "done".');
  });

  it("includes auto-push setting when autoPush is true", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      autoPush: true,
    });
    expect(text).toContain("Auto-push ON");
  });

  it("excludes auto-push setting when autoPush is false", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      autoPush: false,
    });
    expect(text).not.toContain("Auto-push ON");
  });

  it("includes commit-message arg when autoCommit is true", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      autoCommit: true,
    });
    expect(text).toContain("--commit-message");
  });

  it("excludes commit-message arg when autoCommit is false", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      autoCommit: false,
    });
    expect(text).not.toContain("--commit-message");
  });

  it("includes comment format section when autoComment is true", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      autoComment: true,
    });
    expect(text).toContain("Comment format (--comment):");
    expect(text).toContain("Auto-comment ON");
  });

  it("excludes comment format section when autoComment is false", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      autoComment: false,
    });
    expect(text).not.toContain("Comment format (--comment):");
    expect(text).not.toContain("Auto-comment ON");
  });

  it("includes branch creation instructions when createBranch is true", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      createBranch: true,
    });
    expect(text).toContain("Create branch ON");
    expect(text).toContain("git checkout -b");
    expect(text).toContain("Create a branch FIRST");
  });

  it("excludes branch creation instructions when createBranch is false", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      createBranch: false,
    });
    expect(text).not.toContain("Create branch ON");
    expect(text).not.toContain("git checkout -b");
  });

  it("includes verify gate setting when requireVerifyBeforeReview is true", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      requireVerifyBeforeReview: true,
    });
    expect(text).toContain("Verify gate ON");
    expect(text).toContain("need your --set-verify pass verdict at review");
    expect(text).toContain("cannot make that call");
  });

  it("states that verify gathers evidence, cannot judge, and that the agent attests", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      requireVerifyBeforeReview: true,
      autoCommit: true,
      autoComment: true,
    });
    // (1) verify collects evidence and sets nothing
    expect(text).toContain(
      "collect the EVIDENCE — it does NOT set the 'verified' flag",
    );
    // (2) what verify actually proves — and what it cannot
    expect(text).toContain(
      "verify only checks that your annotated element still resolves",
    );
    expect(text).toContain("no NEW console errors");
    expect(text).toContain("CANNOT tell whether you did what the ticket asked");
    // (3) the AGENT must attest, and the attestation is required at review
    expect(text).toContain(
      "--set-verify pass is YOUR attestation that the task IS implemented correctly",
    );
    expect(text).toContain("requires a verdict on annotated (URL + selector) tasks");
    expect(text).toContain(
      "record --set-verify fail — that does NOT pass the gate",
    );
    expect(text).toContain("--set-status review --set-verify pass");
  });

  it("keeps the evidence wording when the verify gate is OFF, without the attestation", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      requireVerifyBeforeReview: false,
    });
    expect(text).toContain("it does NOT set the 'verified' flag");
    expect(text).not.toContain("--set-status review --set-verify pass");
  });

  it("excludes verify gate setting when requireVerifyBeforeReview is false", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      requireVerifyBeforeReview: false,
    });
    expect(text).not.toContain("Verify gate ON");
  });

  it("excludes verify gate setting when requireVerifyBeforeReview is undefined", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false });
    expect(text).not.toContain("Verify gate ON");
  });

  it("tells the agent to ALWAYS attempt verification, even without ground truth", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false });
    expect(text).toContain("ALWAYS attempt verification");
    expect(text).toContain("even with no baseline and no ground truth");
    expect(text).toContain(
      "does the artifact actually satisfy what this ticket asked?",
    );
  });

  it("names the counterexamples that PASS verify but are still wrong", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false });
    expect(text).toContain("making a button green when the ticket");
    expect(text).toContain(
      "fixing a different bug than the ticket describes",
    );
  });

  it("explains how to verify a non-UI task by inspecting the artifact", () => {
    const text = renderAgentInstructions({ hasResearchTasks: false });
    expect(text).toContain("Non-UI task (docs, rename, copy, links, config)");
    expect(text).toContain("grep the old string and assert ZERO occurrences");
    expect(text).toContain("resolve every");
    expect(text).toContain("assert none 404");
    expect(text).toContain("in the package's files list");
    expect(text).toContain("documented command exists in --help");
  });

  it("tells the agent to declare an unverifiable task so no badge shows", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      requireVerifyBeforeReview: true,
      autoCommit: true,
      autoComment: true,
    });
    expect(text).toContain("declare it so no badge shows");
    expect(text).toContain(
      'vibeflow tasks --edit <id> --set-verify cannot --verify-reason "<why>"',
    );
    expect(text).toContain("cannot records no verdict or badge");
    expect(text).toContain("--set-verify fail means you verified it is WRONG");
  });

  it("keeps the always-verify and clearing guidance when the gate is OFF", () => {
    const text = renderAgentInstructions({
      hasResearchTasks: false,
      requireVerifyBeforeReview: false,
    });
    expect(text).toContain("ALWAYS attempt verification");
    expect(text).toContain("Non-UI task (docs, rename, copy, links, config)");
    expect(text).toContain(
      'vibeflow tasks --edit <id> --set-verify cannot --verify-reason "<why>"',
    );
  });
});
