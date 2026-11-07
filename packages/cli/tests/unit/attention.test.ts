/**
 * Needs-attention claim notification pins (owner round 2).
 *
 * When a task is moved into progress on a flagged task, the result MUST
 * surface the flag + the reason comment to the agent — one NEEDS_ATTENTION
 * notice in the payload and exactly one dynamic instruction line. The
 * shipped hook defaults stay untouched (ADR-0007; compressed under
 * hm3sxd140), so these pins assert the operation-owned wording only.
 */
import { describe, it, expect } from "vitest";
import {
  attentionClaimAlert,
  attentionReasonText,
  ATTENTION_NOTICE_CODE,
  ATTENTION_REASON_MAX,
} from "../../src/core/attention.js";

function comment(text: string, createdAt: string, extra = {}) {
  return { id: `c-${createdAt}`, author: "agent", text, createdAt, ...extra };
}

describe("attentionReasonText", () => {
  it("returns null without comments", () => {
    expect(attentionReasonText(undefined)).toBeNull();
    expect(attentionReasonText([])).toBeNull();
  });

  it("picks the latest non-system, non-deleted comment", () => {
    expect(
      attentionReasonText([
        comment("first", "2026-01-01T00:00:00Z"),
        comment("**Cannot verify:** no browser here", "2026-01-02T00:00:00Z", {
          type: "system",
        }),
        comment("gone", "2026-01-03T00:00:00Z", { deleted: true }),
        comment("Blocked: API shape unclear", "2026-01-04T00:00:00Z"),
      ]),
    ).toBe("Blocked: API shape unclear");
  });

  it("collapses whitespace and truncates to one short line", () => {
    const reason = attentionReasonText([
      comment(
        "Blocked:\nline one\n  line two " + "x".repeat(400),
        "2026-01-01T00:00:00Z",
      ),
    ]);
    expect(reason).not.toBeNull();
    expect(reason).not.toContain("\n");
    expect(reason!.length).toBeLessThanOrEqual(ATTENTION_REASON_MAX);
    expect(reason!.startsWith("Blocked: line one line two")).toBe(true);
  });
});

describe("attentionClaimAlert", () => {
  it("returns null when the flag is absent or cleared", () => {
    expect(attentionClaimAlert({ comments: [] }, "t1")).toBeNull();
    expect(
      attentionClaimAlert({ needsAttention: false, comments: [] }, "t1"),
    ).toBeNull();
    expect(attentionClaimAlert(null, "t1")).toBeNull();
  });

  it("surfaces the flag + reason as one notice and one instruction line", () => {
    const alert = attentionClaimAlert(
      {
        needsAttention: true,
        comments: [comment("Blocked: need the API shape", "2026-01-01T00:00:00Z")],
      },
      "task-abc",
    );
    expect(alert).not.toBeNull();
    expect(alert!.notice.code).toBe(ATTENTION_NOTICE_CODE);
    expect(alert!.notice.message).toContain("Blocked: need the API shape");
    // Exactly one instruction line, naming the reason and the thread.
    expect(alert!.instruction).not.toContain("\n");
    expect(alert!.instruction).toContain("Blocked: need the API shape");
    expect(alert!.instruction).toContain("task-abc");
  });

  it("falls back to flag-only wording when no reason comment exists", () => {
    const alert = attentionClaimAlert({ needsAttention: true }, "task-abc");
    expect(alert).not.toBeNull();
    expect(alert!.notice.code).toBe(ATTENTION_NOTICE_CODE);
    expect(alert!.notice.message).toContain("activity feed");
    expect(alert!.instruction).not.toContain("\n");
    expect(alert!.instruction).toContain("task-abc");
  });
});
