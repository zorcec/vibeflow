/**
 * Deterministic color assignment for tag names.
 * Same name → same color on every render, every session.
 */

// 8-color palette (name, background, text, border)
const TAG_PALETTE: Array<{ bg: string; text: string; border: string }> = [
  { bg: 'color-mix(in srgb, var(--p-blue) 14%, transparent)',   text: 'var(--p-blue-200)',   border: 'color-mix(in srgb, var(--p-blue) 30%, transparent)' },
  { bg: 'color-mix(in srgb, var(--p-green) 14%, transparent)',  text: 'var(--p-green-300)',  border: 'color-mix(in srgb, var(--p-green) 30%, transparent)' },
  { bg: 'color-mix(in srgb, var(--p-purple) 14%, transparent)', text: 'var(--p-purple-300)', border: 'color-mix(in srgb, var(--p-purple) 30%, transparent)' },
  { bg: 'color-mix(in srgb, var(--p-amber) 14%, transparent)',  text: 'var(--p-amber-300)',  border: 'color-mix(in srgb, var(--p-amber) 30%, transparent)' },
  { bg: 'color-mix(in srgb, #f472b6 14%, transparent)',         text: '#f9a8d4',              border: 'color-mix(in srgb, #f472b6 30%, transparent)' },
  { bg: 'color-mix(in srgb, var(--p-cyan) 14%, transparent)',   text: 'var(--p-cyan-300)',   border: 'color-mix(in srgb, var(--p-cyan) 30%, transparent)' },
  { bg: 'color-mix(in srgb, #f87171 14%, transparent)',         text: '#fca5a5',              border: 'color-mix(in srgb, #f87171 30%, transparent)' },
  { bg: 'color-mix(in srgb, var(--p-text-g) 14%, transparent)', text: 'var(--p-text-m)',     border: 'color-mix(in srgb, var(--p-text-g) 30%, transparent)' },
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
