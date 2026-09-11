import type { Highlight } from "./whats-new.js";

interface Props {
  /** Newest-first highlight bullets; null/empty renders nothing. */
  items: Highlight[];
}

/**
 * Highlights region pinned above the changelog flow in the What's New modal.
 * Dedicated (non-markdown) banner: gradient card, "✨ Highlights" label, and
 * per-version chips only when bullets span multiple versions. Static content
 * (role=list) — the tagged bullets stay duplicated in the markdown flow below.
 * Renders nothing when there are no tagged highlights.
 */
export function HighlightsBanner({ items }: Props) {
  if (!items || items.length === 0) return null;
  const versions = [...new Set(items.map((h) => h.version))];
  const showVersion = versions.length > 1;
  return (
    <div
      data-role="highlights-region"
      role="list"
      aria-label="Highlights"
      style={{
        marginBottom: 12,
        padding: "12px 14px",
        borderRadius: 10,
        background:
          "linear-gradient(135deg, rgba(37,99,235,0.18), rgba(147,51,234,0.18))",
        border: "1px solid rgba(96,165,250,0.35)",
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: "var(--p-text)",
          marginBottom: 8,
        }}
      >
        ✨ Highlights
      </div>
      {items.map((h, i) => (
        <div
          key={`${h.version}-${i}`}
          role="listitem"
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            fontSize: 13,
            color: "var(--p-text-f)",
            lineHeight: 1.5,
            marginTop: i === 0 ? 0 : 6,
          }}
        >
          <span aria-hidden="true" style={{ flexShrink: 0 }}>
            ✨
          </span>
          {showVersion && (
            <span
              style={{
                flexShrink: 0,
                fontSize: 10,
                fontWeight: 700,
                padding: "1px 6px",
                borderRadius: 999,
                background: "rgba(96,165,250,0.2)",
                color: "#93c5fd",
              }}
            >
              {h.version}
            </span>
          )}
          <span>{h.text}</span>
        </div>
      ))}
    </div>
  );
}
