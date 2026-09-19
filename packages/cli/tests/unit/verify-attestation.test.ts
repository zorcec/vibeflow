import { describe, it, expect } from "vitest";
import { resolveVerifyAttestation } from "../../src/core/verify-attestation.js";

/**
 * Flag parsing for the agent attestation. `verified` is tri-state and is set by
 * the AGENT (the review gate needs the verdict on the transition), so the
 * tri-state `--set-verify` flag must resolve exactly — including the cases the
 * review gate depends on: pass → true, fail → false, cannot → absent, and the
 * hard rule that "cannot" REQUIRES --verify-reason.
 */
describe("resolveVerifyAttestation", () => {
  it("resolves --set-verify pass to true", () => {
    const res = resolveVerifyAttestation({ setVerify: "pass" });
    expect(res).toEqual({
      ok: true,
      value: true,
      clear: false,
      verdict: "pass",
    });
  });

  it("resolves --set-verify fail to false (a completed negative verdict)", () => {
    const res = resolveVerifyAttestation({ setVerify: "fail" });
    expect(res).toEqual({
      ok: true,
      value: false,
      clear: false,
      verdict: "fail",
    });
  });

  it("resolves --set-verify cannot with a reason to absence (no badge)", () => {
    const res = resolveVerifyAttestation({
      setVerify: "cannot",
      verifyReason: "no browser in this environment",
    });
    expect(res).toEqual({
      ok: true,
      value: undefined,
      clear: true,
      verdict: "cannot",
      reason: "no browser in this environment",
    });
  });

  it("resolves no flag to undefined (nothing assessed — leave the store alone)", () => {
    const res = resolveVerifyAttestation({});
    expect(res).toEqual({ ok: true, value: undefined, clear: false });
  });

  it("rejects --set-verify cannot without --verify-reason", () => {
    const res = resolveVerifyAttestation({ setVerify: "cannot" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("--verify-reason");
    }
  });

  it("rejects --set-verify cannot with a blank --verify-reason", () => {
    const res = resolveVerifyAttestation({
      setVerify: "cannot",
      verifyReason: "   ",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("--verify-reason");
    }
  });

  it("rejects --verify-reason without --set-verify cannot (redundant flag)", () => {
    const res = resolveVerifyAttestation({
      setVerify: "pass",
      verifyReason: "why?",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("--set-verify cannot");
    }
  });
});