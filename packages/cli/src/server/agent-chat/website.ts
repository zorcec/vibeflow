/**
 * Webpage text helpers (ticket 0847833f): bounded HTML→text extraction
 * and the untrusted-content wrapper.
 *
 * WHAT: `extractPageText` strips scripts/styles/tags and decodes the
 * common entities with a dependency-free pass (this runs in the CLI
 * server — no DOM, no new packages); `wrapUntrusted` marks the result
 * as third-party DATA so the agent treats it as content to quote, never
 * instructions to follow.
 */
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
