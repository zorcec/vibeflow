/**
 * URL validation utilities — shared between adapters.
 * Blocks cloud metadata endpoints and private IPs to prevent SSRF.
 */

/** Known cloud metadata hostnames */
const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/**
 * Validate a URL to prevent SSRF attacks.
 * Blocks cloud metadata endpoints and non-HTTP protocols.
 *
 * @param url - URL string to validate
 * @param label - Label for error messages (e.g. "SENSEVOICE_URL")
 * @throws Error if URL is invalid or blocked
 */
export function validateUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid ${label}: not a valid URL`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Invalid ${label}: protocol "${parsed.protocol}" not allowed (use http/https)`);
  }

  if (BLOCKED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Invalid ${label}: cloud metadata endpoints not allowed (${parsed.hostname})`);
  }

  // Block link-local addresses (169.254.x.x)
  if (parsed.hostname.startsWith("169.254.")) {
    throw new Error(`Invalid ${label}: link-local addresses not allowed`);
  }
}
