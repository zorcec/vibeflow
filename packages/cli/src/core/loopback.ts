/**
 * Check if an origin URL is loopback (localhost, 127.0.0.1, [::1]).
 * Used by requireSameOrigin to allow local development requests.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "localhost" ||
        u.hostname === "127.0.0.1" ||
        u.hostname === "[::1]" ||
        u.hostname === "::1")
    );
  } catch {
    return false;
  }
}
