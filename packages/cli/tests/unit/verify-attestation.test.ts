import { describe, it, expect } from "vitest";
import { resolveVerifyAttestation } from "../../src/core/verify-attestation.js";

/**
 * Flag parsing for the agent attestation. `verified` is tri-state and is set by
 * the AGENT (the review gate needs the positive value on the transition), so
 * the flag pair must resolve exactly — including the contradictory case.
 */
describe("resolveVerifyAttestation", () => {
  it("resolves --verified to true", () => {
    const res = resolveVerifyAttestation({ verified: true });
    expect(res).toEqual({ ok: true, value: true, clear: false });
  });

  it("resolves --verify-failed to false (a completed negative verdict)", () => {
    const res = resolveVerifyAttestation({ verifyFailed: true });
    expect(res).toEqual({ ok: true, value: false, clear: false });
  });

  it("resolves --unset-verified to absence via clear (not a value)", () => {
    const res = resolveVerifyAttestation({ unset: true });
    expect(res).toEqual({ ok: true, value: undefined, clear: true });
  });

  it("resolves no flag to undefined (nothing assessed — leave the store alone)", () => {
    const res = resolveVerifyAttestation({});
    expect(res).toEqual({ ok: true, value: undefined, clear: false });
  });

  it("rejects --unset-verified combined with --verified as contradictory", () => {
    const res = resolveVerifyAttestation({ unset: true, verified: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("--unset-verified");
      expect(res.message).toContain("--verified");
    }
  });

  it("rejects --unset-verified combined with --verify-failed as contradictory", () => {
    const res = resolveVerifyAttestation({ unset: true, verifyFailed: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("--unset-verified");
      expect(res.message).toContain("--verify-failed");
    }
  });

  it("rejects --verified together with --verify-failed as contradictory", () => {
    const res = resolveVerifyAttestation({
      verified: true,
      verifyFailed: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("--verified");
      expect(res.message).toContain("--verify-failed");
    }
  });

  it("ignores explicit false flags (only the positive flag attests)", () => {
    // Commander only sets these to true; passing false must behave like absent.
    const res = resolveVerifyAttestation({
      verified: false,
      verifyFailed: false,
      unset: false,
    });
    expect(res).toEqual({ ok: true, value: undefined, clear: false });
  });
});
