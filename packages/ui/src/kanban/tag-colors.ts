/**
 * Deterministic color assignment for tag names.
 * Same name → same color on every render, every session.
 */

// 8-color palette (name, background, text, border).
// The HUE is fixed palette data: a tag keeps its colour no matter which
// data-theme is active, exactly like the type/priority badge palettes. The
// text colour is the one exception — it comes from the shared chip tier
// (--t-chip-*), because the legacy dark-theme hues drop to 1.3-2.2:1 on a light
// card. The dark and hc-dark chip values are byte-identical to those hues.
const TAG_PALETTE: Array<{ bg: string; text: string; border: string }> = [
 {
  bg: "color-mix(in srgb, #2563eb 14%, transparent)",
  text: "var(--t-chip-blue-200)",
  border: "color-mix(in srgb, #2563eb 30%, transparent)",
 },
 {
  bg: "color-mix(in srgb, #22c55e 14%, transparent)",
  text: "var(--t-chip-green-300)",
  border: "color-mix(in srgb, #22c55e 30%, transparent)",
 },
 {
  bg: "color-mix(in srgb, #a78bfa 14%, transparent)",
  text: "var(--t-chip-purple-300)",
  border: "color-mix(in srgb, #a78bfa 30%, transparent)",
 },
 {
  bg: "color-mix(in srgb, #f59e0b 14%, transparent)",
  text: "var(--t-chip-amber-300)",
  border: "color-mix(in srgb, #f59e0b 30%, transparent)",
 },
 {
  bg: "color-mix(in srgb, #f472b6 14%, transparent)",
  text: "var(--t-chip-pink-300)",
  border: "color-mix(in srgb, #f472b6 30%, transparent)",
 },
 {
  bg: "color-mix(in srgb, #22d3ee 14%, transparent)",
  text: "var(--t-chip-cyan-300)",
  border: "color-mix(in srgb, #22d3ee 30%, transparent)",
 },
 {
  bg: "color-mix(in srgb, #f87171 14%, transparent)",
  text: "var(--t-chip-red-300)",
  border: "color-mix(in srgb, #f87171 30%, transparent)",
 },
 {
  bg: "color-mix(in srgb, #475569 14%, transparent)",
  text: "var(--t-chip-slate-400)",
  border: "color-mix(in srgb, #475569 30%, transparent)",
 },
];

/** Hash a tag name to a stable palette index. */
function hashTagName(name: string): number {
 let hash = 0;
 for (let i = 0; i < name.length; i++) {
  hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
 }
 return hash % TAG_PALETTE.length;
}

export function getTagColors(name: string) {
 return TAG_PALETTE[hashTagName(name)];
}
