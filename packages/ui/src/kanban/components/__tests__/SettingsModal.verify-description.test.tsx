// @vitest-environment jsdom
/**
 * SettingsModal enforcement tab — the verify-before-review description.
 *
 * Task e746539a: "Keep the description correct and short."
 *
 * The old copy said the CLI "enforces vibeflow verify before setting status to
 * review", which is wrong and misleading: the gate requires the agent's
 * `--verified` ATTESTATION at the review transition (review-gate.ts gate 4b).
 * `vibeflow verify` only gathers evidence — it explicitly cannot decide whether
 * the task was accomplished, and it does not set the flag.
 *
 * These assertions pin the corrected wording so the inaccurate claim cannot
 * return, and pin the documented scope (annotated tasks) and reset behaviour
 * (cleared on returning to in-progress).
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsModal } from "../SettingsModal";

function renderModal() {
  return render(
    <SettingsModal
      open
      visibleCols={["todo", "in-progress", "review"]}
      settings={{}}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />,
  );
}

/** The verification toggle's description text. */
async function verifyDescription(): Promise<string> {
  renderModal();
  // The Enforcement tab is where the workflow toggles live.
  fireEvent.click(screen.getByRole("button", { name: /enforcement/i }));
  const label = await screen.findByText("Require verify before review");
  // WorkflowToggle renders label, then its description as the next sibling.
  const description = label.nextElementSibling;
  return (description?.textContent ?? "").trim();
}

describe("verify-before-review description (e746539a)", () => {
  it("names the attestation, not the act of running verify", async () => {
    const text = await verifyDescription();
    expect(text).toContain("--verified");
    expect(text).toContain("attestation");
    // The old, wrong wording must not come back.
    expect(text).not.toContain("enforces vibeflow verify");
  });

  it("scopes the gate to tasks with a URL and selector", async () => {
    const text = await verifyDescription();
    expect(text).toMatch(/URL and selector/i);
  });

  it("states that the flag is cleared when the task returns to in-progress", async () => {
    const text = await verifyDescription();
    expect(text).toMatch(/in-progress/i);
    expect(text).toMatch(/clear/i);
  });

  it("stays short — a settings description, not a paragraph", async () => {
    const text = await verifyDescription();
    // The old copy ran to 176 characters on one cramped line.
    expect(text.length).toBeLessThan(140);
  });

  it("is materially shorter than the copy it replaces", async () => {
    const text = await verifyDescription();
    const previous =
      "CLI enforces vibeflow verify before setting status to review (skipped for tasks without URL/selector). The 'verified' flag persists until the task is moved back to in-progress.";
    expect(text.length).toBeLessThan(previous.length * 0.8);
  });
});
