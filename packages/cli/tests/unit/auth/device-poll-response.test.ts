import { describe, it, expect } from "vitest";

// Ticket 64204dec: the device-poll contract is FOUR shapes, not three.
// The reuse shape ({ reused: true, tokenId, name }) used to fall through
// to "pending" and die as a misleading "expired" on the next poll. These
// pin the parser: every known shape classifies, anything else throws the
// named error instead of polling forever.
import {
  parseDevicePollResponse,
  UnexpectedDevicePollResponseError,
} from "../../../src/auth/login.js";

describe("parseDevicePollResponse (ticket 64204dec)", () => {
  it("classifies { pending: true }", () => {
    expect(parseDevicePollResponse({ pending: true })).toEqual({
      kind: "pending",
    });
  });

  it("classifies { token }", () => {
    expect(parseDevicePollResponse({ token: "vbf_pat_secret" })).toEqual({
      kind: "token",
      token: "vbf_pat_secret",
    });
  });

  it("classifies { expired: true }", () => {
    expect(parseDevicePollResponse({ expired: true })).toEqual({
      kind: "expired",
    });
  });

  it("classifies the reuse shape { reused: true, tokenId, name }", () => {
    expect(
      parseDevicePollResponse({
        reused: true,
        tokenId: "pat-live",
        name: "field-box (Linux)",
      }),
    ).toEqual({ kind: "reused", tokenId: "pat-live", name: "field-box (Linux)" });
  });

  it("rejects { reused: true } without identity (never adopt blindly)", () => {
    expect(() => parseDevicePollResponse({ reused: true })).toThrowError(
      UnexpectedDevicePollResponseError,
    );
  });

  it("throws the named error on an unknown shape — and names the keys", () => {
    let caught: unknown = null;
    try {
      parseDevicePollResponse({ frobnicate: true, answer: 42 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnexpectedDevicePollResponseError);
    const err = caught as UnexpectedDevicePollResponseError;
    expect(err.code).toBe("UNEXPECTED_DEVICE_POLL_RESPONSE");
    expect(err.keys).toEqual(expect.arrayContaining(["frobnicate", "answer"]));
    expect(err.message).toContain("frobnicate");
    expect(err.message).toContain("answer");
  });

  it("throws on non-object bodies (null, arrays, strings)", () => {
    for (const body of [null, [], "pending", 42]) {
      expect(() => parseDevicePollResponse(body)).toThrowError(
        UnexpectedDevicePollResponseError,
      );
    }
  });

  it("throws on a non-string token (never store garbage as a credential)", () => {
    expect(() => parseDevicePollResponse({ token: 42 })).toThrowError(
      UnexpectedDevicePollResponseError,
    );
    expect(() => parseDevicePollResponse({ token: "" })).toThrowError(
      UnexpectedDevicePollResponseError,
    );
  });
});
