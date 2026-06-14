/**
 * Simple per-user rate limiter using sliding window counter.
 * Uses lazy cleanup — expired buckets are removed on access, not on a timer.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_RAW = parseInt(process.env.RATE_LIMIT_MAX || "10", 10);
const WINDOW_RAW = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
const MAX = Number.isFinite(MAX_RAW) && MAX_RAW > 0 ? MAX_RAW : 10;
const WINDOW = Number.isFinite(WINDOW_RAW) && WINDOW_RAW > 0 ? WINDOW_RAW : 60_000;
const MAX_BUCKETS = 10_000;

/**
 * Lazy cleanup: remove expired buckets when map grows too large.
 * O(n) only when near capacity, otherwise O(1).
 */
function cleanupIfNeeded(): void {
  if (buckets.size < MAX_BUCKETS) return;

  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) {
      buckets.delete(key);
    }
  }
}

export function isAllowed(userId: string): boolean {
  const now = Date.now();
  const b = buckets.get(userId);

  if (!b || now > b.resetAt) {
    // New bucket or expired — clean up this user's old entry if exists
    if (b) buckets.delete(userId);
    cleanupIfNeeded();
    buckets.set(userId, { count: 1, resetAt: now + WINDOW });
    return true;
  }

  if (b.count >= MAX) return false;
  b.count++;
  return true;
}

export function retryAfter(userId: string): number {
  const b = buckets.get(userId);
  if (!b) return 0;
  return Math.max(0, Math.ceil((b.resetAt - Date.now()) / 1000));
}

/** Reset rate limiter state (for testing) */
export function _resetRateLimiter(): void {
  buckets.clear();
}
