/**
 * The follower's failure policy, as pure functions (ticket liolbrdi).
 *
 * These are the rules a long-lived reader lives or dies by, so they are tested
 * without a process, a socket or a clock: which failures to retry, which to
 * treat as a typed recovery, which to stop on, and how long to wait.
 */
import { describe, it, expect } from "vitest";
import {
  NOTIFICATIONS_RETRY_BASE_MS,
  NOTIFICATIONS_RETRY_CAP_MS,
  backoffDelayMs,
  isCursorExpired,
  isTerminalNotificationFailure,
  retryDelayMs,
  type FetchRefusal,
} from "../../../src/core/notifications-retry.js";

const refusal = (patch: Partial<FetchRefusal> = {}): FetchRefusal => ({
  ok: false,
  code: "NOTIFICATIONS_FETCH_FAILED",
  message: "boom",
  ...patch,
});

describe("backoffDelayMs", () => {
  it("grows exponentially from the base and never exceeds the cap", () => {
    // Full jitter is a uniform draw over [0, ceiling]: random() = 1 shows the
    // ceiling itself, which is the only way to assert the curve exactly.
    const ceiling = (attempt: number): number => backoffDelayMs(attempt, () => 1);
    expect(ceiling(1)).toBe(NOTIFICATIONS_RETRY_BASE_MS);
    expect(ceiling(2)).toBe(NOTIFICATIONS_RETRY_BASE_MS * 2);
    expect(ceiling(3)).toBe(NOTIFICATIONS_RETRY_BASE_MS * 4);
    expect(ceiling(50)).toBe(NOTIFICATIONS_RETRY_CAP_MS);
  });

  it("draws below the ceiling (jitter is not decoration)", () => {
    expect(backoffDelayMs(4, () => 0)).toBe(0);
    expect(backoffDelayMs(4, () => 0.5)).toBe(
      Math.round(0.5 * NOTIFICATIONS_RETRY_BASE_MS * 8),
    );
  });

  it("treats a non-positive attempt as the first step", () => {
    expect(backoffDelayMs(0, () => 1)).toBe(NOTIFICATIONS_RETRY_BASE_MS);
    expect(backoffDelayMs(-3, () => 1)).toBe(NOTIFICATIONS_RETRY_BASE_MS);
  });
});

describe("isTerminalNotificationFailure", () => {
  it("stops for a credential, a scope or a usage refusal", () => {
    expect(isTerminalNotificationFailure(refusal({ status: 401 }))).toBe(true);
    expect(isTerminalNotificationFailure(refusal({ status: 403 }))).toBe(true);
    expect(isTerminalNotificationFailure(refusal({ status: 422 }))).toBe(true);
    expect(isTerminalNotificationFailure(refusal({ status: 404 }))).toBe(true);
    expect(isTerminalNotificationFailure(refusal({ code: "NOT_CONNECTED" }))).toBe(true);
    expect(isTerminalNotificationFailure(refusal({ code: "E_USAGE" }))).toBe(true);
  });

  it("retries the transient ones, and anything it does not recognise", () => {
    expect(isTerminalNotificationFailure(refusal({ status: 429 }))).toBe(false);
    expect(isTerminalNotificationFailure(refusal({ status: 500 }))).toBe(false);
    expect(isTerminalNotificationFailure(refusal({ status: 503 }))).toBe(false);
    expect(isTerminalNotificationFailure(refusal({ status: 408 }))).toBe(false);
    // A transport failure has no status at all: the socket dropped, not the
    // credential. Silence is the expensive failure, so this retries.
    expect(isTerminalNotificationFailure(refusal())).toBe(false);
    expect(isTerminalNotificationFailure(refusal({ code: "SOMETHING_NEW" }))).toBe(false);
  });
});

describe("isCursorExpired", () => {
  it("recognises the typed recovery and nothing else", () => {
    expect(isCursorExpired(refusal({ code: "INVALID_SINCE" }))).toBe(true);
    expect(isCursorExpired(refusal({ status: 400 }))).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("obeys Retry-After when the board gave one", () => {
    expect(retryDelayMs(refusal({ retryAfterMs: 1200 }), 1, () => 1)).toBe(1200);
  });

  it("caps a hostile Retry-After instead of parking the follower", () => {
    expect(retryDelayMs(refusal({ retryAfterMs: 86_400_000 }), 1)).toBe(
      NOTIFICATIONS_RETRY_CAP_MS,
    );
  });

  it("falls back to the backoff step when there is no header", () => {
    expect(retryDelayMs(refusal(), 2, () => 1)).toBe(NOTIFICATIONS_RETRY_BASE_MS * 2);
    // A zero/negative header is ignored, never a busy loop.
    expect(retryDelayMs(refusal({ retryAfterMs: 0 }), 1, () => 1)).toBe(
      NOTIFICATIONS_RETRY_BASE_MS,
    );
  });
});
