import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isAllowed, retryAfter, _resetRateLimiter } from "../../src/telegram/rate-limiter.js";

describe("rate-limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetRateLimiter();
    // Reset by advancing time past the window
    vi.advanceTimersByTime(61_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows first request", () => {
    expect(isAllowed("100001")).toBe(true);
  });

  it("blocks after max requests", () => {
    for (let i = 0; i < 10; i++) {
      isAllowed("100002");
    }
    expect(isAllowed("100002")).toBe(false);
  });

  it("resets after window expires", () => {
    for (let i = 0; i < 10; i++) {
      isAllowed("100003");
    }
    expect(isAllowed("100003")).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect(isAllowed("100003")).toBe(true);
  });

  it("returns 0 retryAfter for unknown user", () => {
    expect(retryAfter("999999")).toBe(0);
  });

  it("returns positive retryAfter for rate-limited user", () => {
    for (let i = 0; i < 10; i++) {
      isAllowed("100004");
    }
    expect(retryAfter("100004")).toBeGreaterThan(0);
  });

  it("tracks different users independently", () => {
    for (let i = 0; i < 10; i++) {
      isAllowed("100005");
    }
    expect(isAllowed("100005")).toBe(false);
    expect(isAllowed("100006")).toBe(true);
  });

  it("cleans up expired buckets when approaching limit", () => {
    // Create many users
    for (let i = 0; i < 100; i++) {
      isAllowed(`user-${i}`);
    }

    // Advance time so all buckets expire
    vi.advanceTimersByTime(61_000);

    // Next call should trigger cleanup
    isAllowed("trigger-cleanup");

    // Old users should be cleaned up (their buckets expired)
    // After cleanup, expired buckets are removed
    expect(isAllowed("user-0")).toBe(true); // expired, should be allowed
  });

  it("cleanup runs when bucket count exceeds MAX_BUCKETS", () => {
    // Create many users to trigger cleanup threshold
    for (let i = 0; i < 10_001; i++) {
      isAllowed(`bulk-${i}`);
    }

    // The cleanup should have run — verify it doesn't crash
    // and the system still works correctly
    expect(isAllowed("new-user-after-cleanup")).toBe(true);
  });
});
