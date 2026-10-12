import { describe, it, expect } from "vitest";
import {
  scanChangesetText,
  scanPendingChangesets,
  listPendingChangesets,
  findRepoRootWithChangeset,
} from "../../../src/core/changeset-guard.js";

describe("scanChangesetText banned private-product markers", () => {
  it.each([
    ["SaaS mode no longer PATCHes on dry run", "saas-wording"],
    ["fixed in vibeflow-private/deploy", "private-monorepo"],
    ["see packages/web/src/app for details", "web-app-path"],
    ["bump @vibeflow-tools/web to 0.2", "web-package"],
    ["the online kanban shows presence", "online-product"],
    ["mirrors the online board behaviour", "online-product"],
    ["fixed in online mode only", "online-product"],
    ["behind cloud sync conflicts", "cloud-sync"],
    ["requires billing checkout", "billing"],
    ["via the tRPC mutation", "trpc"],
    ["Supabase realtime broadcast", "supabase"],
    ["task 60ea2441abcdef0123456789abcdef01 landed", "internal-id"],
    ["stored under /home/user/.vibeflow", "local-filesystem-path"],
  ])("flags %p as %p", (body, rule) => {
    const violations = scanChangesetText(
      `---\n"@vibeflow-tools/cli": patch\n---\n\n${body}\n`,
    );
    expect(violations.map((v) => v.rule)).toContain(rule);
  });

  it("does not flag @vibeflow-tools/web-crawl (still a public package)", () => {
    expect(
      scanChangesetText('"@vibeflow-tools/web-crawl": patch\n\nFix crawl\n'),
    ).toEqual([]);
  });
});

describe("scanChangesetText customer-facing public text", () => {
  it.each([
    "Fix `tasks --get` returning empty for child tasks.",
    "Rename customer-facing proto surfaces to Vibeflow naming.",
    // Presence is a public CLI board feature (multi-session local board,
    // shipped in 0.20.0) — must NOT be flagged as private-product text.
    "Presence chips go high-contrast right; presence stays informational and never locks editing.",
    "An edited comment now propagates to other sessions without a reload.",
    "The board no longer locks a task while someone else has it open: the Locked by banner is gone.",
  ])("passes clean public entry: %p", (body) => {
    expect(scanChangesetText(body)).toEqual([]);
  });
});

describe("pending changesets customer-facing constraint", () => {
  it("finds the repo .changeset directory from the test tree", () => {
    expect(findRepoRootWithChangeset(__dirname)).not.toBeNull();
  });

  it("every pending changeset is free of private-product markers", () => {
    const root = findRepoRootWithChangeset(__dirname);
    expect(root).not.toBeNull();
    const pending = listPendingChangesets(root!);
    const failures = scanPendingChangesets(root!);
    expect(
      failures,
      failures.length > 0
        ? `private-product text in pending changesets: ${JSON.stringify(failures, null, 2)} (pending: ${pending.map((p) => p.file).join(", ")})`
        : `pending: ${pending.map((p) => p.file).join(", ")}`,
    ).toEqual([]);
  });
});
