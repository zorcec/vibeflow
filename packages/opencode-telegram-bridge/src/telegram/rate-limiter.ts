/**
 * Simple per-user rate limiter using sliding window counter.
 * Includes periodic cleanup to prevent memory exhaustion.
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

/** Periodic cleanup of expired buckets to prevent memory leak */
let lastCleanup = Date.now();
function cleanupIfNeeded(): void {
  const now = Date.now();
  // Run cleanup every 5 minutes or when approaching limit
  if (buckets.size < MAX_BUCKETS && now - lastCleanup < 300_000) return;
  lastCleanup = now;

  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) {
      buckets.delete(key);
    }
  }
}

export function isAllowed(userId: string): boolean {
  cleanupIfNeeded();

  const now = Date.now();
  const b = buckets.get(userId);

  if (!b || now > b.resetAt) {
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
  lastCleanup = Date.now();
}
