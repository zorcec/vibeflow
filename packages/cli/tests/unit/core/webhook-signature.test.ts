import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  WEBHOOK_DEFAULT_MAX_AGE_SEC,
  WEBHOOK_SIGNATURE_HEADER,
  signWebhookBody,
  verifyWebhookSignature,
} from "@vibeflow-tools/shared";

const SECRET = "whsec_test_secret_123";
const BODY = JSON.stringify({ type: "new", taskId: "task-aaa" });

/** Reference HMAC from Node's implementation — pins our dependency-free one. */
function referenceSig(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
}

describe("webhook signature scheme", () => {
  it("exposes the documented header name", () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("X-Vibeflow-Signature");
  });

  it("matches Node's HMAC-SHA256 over '<timestamp>.<body>'", () => {
    for (const body of [
      BODY,
      "",
      "{}",
      "héllo wörld ✓ — unicode body",
      "x".repeat(10_000),
    ]) {
      const signed = signWebhookBody(SECRET, body, 1_700_000_000);
      expect(signed.signature).toBe(referenceSig(SECRET, 1_700_000_000, body));
      expect(signed.headerValue).toBe(
        `t=1700000000,v1=${signed.signature}`,
      );
    }
  });

  it("matches the RFC 4231 HMAC-SHA256 test vector (key = 20x 0x0b)", () => {
    // RFC 4231 case 1 pins the raw HMAC core; go through the same payload
    // shape the signer uses (timestamp prefix) via the reference impl.
    const key = "\x0b".repeat(20);
    const signed = signWebhookBody(key, "Hi There", 7);
    expect(signed.signature).toBe(referenceSig(key, 7, "Hi There"));
    expect(createHmac("sha256", Buffer.alloc(20, 0x0b)).update("Hi There").digest("hex")).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("sign → verify round-trips", () => {
    const signed = signWebhookBody(SECRET, BODY);
    expect(verifyWebhookSignature(SECRET, BODY, signed.headerValue)).toBe(true);
  });

  it("rejects a TAMPERED body", () => {
    const signed = signWebhookBody(SECRET, BODY);
    const tampered = JSON.stringify({ type: "new", taskId: "task-evil" });
    expect(verifyWebhookSignature(SECRET, tampered, signed.headerValue)).toBe(
      false,
    );
    // Even a single appended byte breaks the signature.
    expect(verifyWebhookSignature(SECRET, BODY + " ", signed.headerValue)).toBe(
      false,
    );
  });

  it("rejects a STALE timestamp (replay)", () => {
    const now = 1_700_000_000;
    const stale = signWebhookBody(
      SECRET,
      BODY,
      now - WEBHOOK_DEFAULT_MAX_AGE_SEC - 1,
    );
    expect(
      verifyWebhookSignature(SECRET, BODY, stale.headerValue, { nowSec: now }),
    ).toBe(false);
    // Boundary: exactly maxAge old still verifies.
    const edge = signWebhookBody(
      SECRET,
      BODY,
      now - WEBHOOK_DEFAULT_MAX_AGE_SEC,
    );
    expect(
      verifyWebhookSignature(SECRET, BODY, edge.headerValue, { nowSec: now }),
    ).toBe(true);
  });

  it("rejects far-future timestamps, wrong secrets, and malformed headers", () => {
    const now = 1_700_000_000;
    const future = signWebhookBody(SECRET, BODY, now + 3600);
    expect(
      verifyWebhookSignature(SECRET, BODY, future.headerValue, { nowSec: now }),
    ).toBe(false);

    const signed = signWebhookBody(SECRET, BODY, now);
    expect(
      verifyWebhookSignature("wrong-secret", BODY, signed.headerValue, {
        nowSec: now,
      }),
    ).toBe(false);
    for (const bad of [
      null,
      undefined,
      "",
      "not-a-signature",
      "t=abc,v1=deadbeef",
      `t=${now},v1=zz-top`,
      `t=${now},v2=${signed.signature}`,
      `t=${now},v1=${signed.signature}tampered`,
    ]) {
      expect(
        verifyWebhookSignature(SECRET, BODY, bad as string, { nowSec: now }),
      ).toBe(false);
    }
  });
});
