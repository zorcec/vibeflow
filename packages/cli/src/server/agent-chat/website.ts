/**
 * Webpage text helpers (ticket 0847833f): bounded HTML→text extraction
 * and the untrusted-content wrapper.
 *
 * WHAT: `extractPageText` strips scripts/styles/tags and decodes the
 * common entities with a dependency-free pass (this runs in the CLI
 * server — no DOM, no new packages); `wrapUntrusted` marks the result
 * as third-party DATA so the agent treats it as content to quote, never
 * instructions to follow. `isBlockedIp` / `isBlockedHostname` are the
 * SSRF guard for server-side fetches (review P1): loopback, private
 * nets, link-local (cloud metadata), and non-public DNS names are
 * refused before any socket opens, on every redirect hop.
 */

/**
 * Hosts that must never be fetched server-side. Covers loopback,
 * private nets, link-local (cloud metadata: 169.254.169.254),
 * multicast/reserved ranges, for IPv4 literals and IPv6 forms
 * (compressed, bracketed, v4-mapped), plus non-public DNS names.
 */
const BLOCKED_TLDS = new Set([
  "localhost",
  "local",
  "internal",
  "invalid",
  "test",
  "example",
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const b = Number(p);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = n * 256 + b;
  }
  return n >>> 0;
}

function inCidr(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** True when a literal IP address is non-routable from the server. */
export function isBlockedIp(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    return (
      inCidr(v4, "127.0.0.0", 8) ||
      inCidr(v4, "10.0.0.0", 8) ||
      inCidr(v4, "172.16.0.0", 12) ||
      inCidr(v4, "192.168.0.0", 16) ||
      inCidr(v4, "169.254.0.0", 16) ||
      inCidr(v4, "224.0.0.0", 4) ||
      v4 === 0 ||
      v4 === 0xffffffff
    );
  }
  const v6 = ip.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  // ::1 loopback, :: unspecified, fe80::/10 + fec0::/10 link-local,
  // fc00::/7 unique-local, ff00::/8 multicast, ::ffff:0:0/96 v4-mapped
  // (the embedded v4 is checked by the caller after unwrapping).
  return (
    v6 === "::1" ||
    v6 === "::" ||
    v6.startsWith("fe80:") ||
    v6.startsWith("fec0:") ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("ff") ||
    v6.startsWith("::ffff:")
  );
}

/**
 * True when a hostname must not be resolved+fetched: IP literals that
 * are non-routable, or DNS names under non-public TLDs / localhost.
 * Plain dotless hostnames (intranet short names) are allowed through —
 * they resolve via site DNS, and the resolved IPs are still checked by
 * `isBlockedIp` after lookup.
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return true;
  if (isBlockedIp(host)) return true;
  const lastDot = host.lastIndexOf(".");
  const tld = lastDot === -1 ? host : host.slice(lastDot + 1);
  if (BLOCKED_TLDS.has(tld)) return true;
  return false;
}
const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return _;
      }
    })
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => ENTITY_MAP[name] ?? m);
}

/**
 * Extract readable text from an HTML (or plain-text) document. Bounded
 * and dependency-free: drops script/style/noscript/template blocks and
 * comments first, then tags, then collapses whitespace runs.
 */
export function extractPageText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<template[\s\S]*?<\/template\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutScripts
    .replace(/<(br|p|div|li|tr|h[1-6])[\s>]/gi, "\n$&")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(withBreaks).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Wrap third-party web content so the agent can quote it but must never
 * obey it. The `source` names where it came from (url or "live-dom").
 */
export function wrapUntrusted(content: string, source: string): string {
  const safeSource = source.replace(/[<>"\]]/g, "");
  return `<untrusted-webpage source="${safeSource}">\n${content}\n</untrusted-webpage>`;
}
