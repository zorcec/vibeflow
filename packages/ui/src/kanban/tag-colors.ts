/**
 * Deterministic color assignment for tag names.
 * Same name → same color on every render, every session.
 */

// 8-color palette (name, background, text, border).
// These are fixed palette DATA, not theme tokens: a tag keeps its colour no
// matter which data-theme is active, exactly like the type/priority badge
// palettes. Values are the dark-theme hues the palette has always rendered.
const TAG_PALETTE: Array<{ bg: string; text: string; border: string }> = [
  { bg: 'color-mix(in srgb, #2563eb 14%, transparent)', text: '#93c5fd', border: 'color-mix(in srgb, #2563eb 30%, transparent)' },
  { bg: 'color-mix(in srgb, #22c55e 14%, transparent)', text: '#6ee7b7', border: 'color-mix(in srgb, #22c55e 30%, transparent)' },
  { bg: 'color-mix(in srgb, #a78bfa 14%, transparent)', text: '#c4b5fd', border: 'color-mix(in srgb, #a78bfa 30%, transparent)' },
  { bg: 'color-mix(in srgb, #f59e0b 14%, transparent)', text: '#fcd34d', border: 'color-mix(in srgb, #f59e0b 30%, transparent)' },
  { bg: 'color-mix(in srgb, #f472b6 14%, transparent)', text: '#f9a8d4', border: 'color-mix(in srgb, #f472b6 30%, transparent)' },
  { bg: 'color-mix(in srgb, #22d3ee 14%, transparent)', text: '#7dd3fc', border: 'color-mix(in srgb, #22d3ee 30%, transparent)' },
  { bg: 'color-mix(in srgb, #f87171 14%, transparent)', text: '#fca5a5', border: 'color-mix(in srgb, #f87171 30%, transparent)' },
  { bg: 'color-mix(in srgb, #475569 14%, transparent)', text: '#94a3b8', border: 'color-mix(in srgb, #475569 30%, transparent)' },
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
