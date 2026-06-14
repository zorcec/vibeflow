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
 * Check if an IPv4 address is in a private/reserved range.
 * Blocks: 10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, 0.x
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||                         // "0.x.x.x" current network
    a === 10 ||                        // 10.0.0.0/8 (private)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 (private)
    a === 127 ||                       // 127.0.0.0/8 (loopback)
    (a === 169 && b === 254) ||        // 169.254.0.0/16 (link-local)
    a === 192 && b === 168             // 192.168.0.0/16 (private)
  );
}

/**
 * Check if an IPv6 address is in a private/reserved range.
 * Blocks: ::1, fc00::/7, fe80::/10, ::ffff:0:0/96 (IPv4-mapped)
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (
    normalized === "::1" ||                          // loopback
    normalized === "::" ||                            // unspecified
    normalized.startsWith("fc") ||                    // ULA (fc00::/7)
    normalized.startsWith("fd") ||                    // ULA (fc00::/7)
    normalized.startsWith("fe80") ||                  // link-local (fe80::/10)
    normalized.startsWith("::ffff:")                  // IPv4-mapped
  ) {
    return true;
  }
  return false;
}

/**
 * Validate a URL to prevent SSRF attacks.
 * Blocks cloud metadata endpoints, private IPs, and non-HTTP protocols.
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

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error(`Invalid ${label}: this hostname is not allowed (${hostname})`);
  }

  // Block IPv4 private/reserved ranges
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      throw new Error(`Invalid ${label}: private/reserved IP addresses not allowed (${hostname})`);
    }
  }

  // Block IPv6 private/reserved ranges (bracketed or plain)
  const ipv6 = hostname.replace(/^\[|\]$/g, "");
  if (ipv6.includes(":")) {
    if (isPrivateIPv6(ipv6)) {
      throw new Error(`Invalid ${label}: private/reserved IPv6 addresses not allowed (${hostname})`);
    }
  }
}
