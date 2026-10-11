import React from "react";
import { Check, Copy } from "lucide-react";

/**
 * Copy `text` to the clipboard. navigator.clipboard needs a secure context —
 * the CLI board served over plain http on a LAN address is not one — so fall
 * back to the deprecated execCommand path, which still works everywhere.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
        try {
                if (navigator.clipboard?.writeText) {
                        await navigator.clipboard.writeText(text);
                        return;
                }
        } catch {
                /* permission denied or insecure context — fall through */
        }
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
                document.execCommand("copy");
        } finally {
                document.body.removeChild(ta);
        }
}

/**
 * Minimalistic hover-revealed affordance: copies the task id so the detail
 * panel does not have to be opened just to read it. On parent cards it is a
 * small hover-revealed pill (see .card-copy-id in kanban.css); on child rows
 * (be8d59c7) it is the full-height segment at the row's right edge inside
 * .child-row-actions — same action, same "copied" check feedback, same
 * accessible name. Swaps to a check for 1.2s as copy feedback. Rendered as a
 * SIBLING of the row root inside .child-row-wrap (never inside the row's
 * div[role=button]), so no interactive element nests inside another at all
 * and no stopPropagation shim is needed against the row — the click/mousedown
 * guards below only stop the enclosing card article's onClick.
 *
 * Edge mode (edge=true) carries its own inline visual style — full-height
 * tab, faint glyph at rest, lit well on hover/focus, green well while the
 * "copied" check shows — so the segment looks designed with zero stylesheet
 * dependency. All colours are semantic --t-* tokens, so dark + light themes
 * recolour together. Pill mode keeps the historical stylesheet look.
 */
export function CopyIdButton({
        taskId,
        className,
        edge,
        edgeEnd,
        style,
}: {
        taskId: string;
        /** Extra modifier class, e.g. "card-copy-id--child" for child rows. */
        className?: string;
        /** Full-height right-edge tab rendering (child rows). Default: pill. */
        edge?: boolean;
        /** True when the tab caps the strip's right end (rounded outer
            corner); false when a sibling segment (Unlink) follows it. */
        edgeEnd?: boolean;
        /** Extra inline style, merged last (wins over the edge defaults). */
        style?: React.CSSProperties;
}) {
        const [copied, setCopied] = React.useState(false);
        const [hovered, setHovered] = React.useState(false);
        const [focused, setFocused] = React.useState(false);
        const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        React.useEffect(
                () => () => {
                        if (timer.current) clearTimeout(timer.current);
                },
                [],
        );
        const lit = hovered || focused;
        // Inline edge visual: defeats the legacy absolute-pill rules so the
        // tab stretches the strip's full height whatever the stylesheet holds.
        const edgeStyle: React.CSSProperties | undefined = edge
                ? {
                          position: "static",
                          right: "auto",
                          top: "auto",
                          transform: "none",
                          alignSelf: "stretch",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          minWidth: 30,
                          minHeight: 22,
                          padding: "0 8px",
                          border: "none",
                          borderRadius:
                                  edgeEnd === false ? 0 : "0 6px 6px 0",
                          opacity: 1,
                          cursor: "pointer",
                          flexShrink: 0,
                          color: copied
                                  ? "var(--t-chip-green-300)"
                                  : lit
                                    ? "var(--t-text)"
                                    : "var(--t-text-faint)",
                          background: copied
                                  ? "color-mix(in srgb, var(--t-chip-green-300) 12%, transparent)"
                                  : lit
                                    ? "color-mix(in srgb, var(--t-accent) 16%, transparent)"
                                    : "transparent",
                          outline: focused
                                  ? "2px solid color-mix(in srgb, var(--t-accent) 65%, transparent)"
                                  : "none",
                          outlineOffset: -2,
                          transition: "background 0.1s, color 0.1s",
                          ...style,
                  }
                : style;
        return (
                <button
                        className={
                                className
                                        ? `card-copy-id ${className}`
                                        : "card-copy-id"
                        }
                        data-role="copy-id"
                        data-copied={copied ? "true" : undefined}
                        draggable={false}
                        aria-label="Copy task id"
                        title={`Copy task id ${taskId}`}
                        type="button"
                        style={edgeStyle}
                        // Visual styling (box, lit hover background, colour) lives entirely
                        // in .card-copy-id in kanban.css so it lights up like the tree
                        // toggle chip. No inline background/colour here — an inline
                        // `background: transparent` outranks the :hover rule and kills
                        // the lit pill.
                        onMouseDown={(e) => e.stopPropagation()}
                        onMouseEnter={
                                edge ? () => setHovered(true) : undefined
                        }
                        onMouseLeave={
                                edge ? () => setHovered(false) : undefined
                        }
                        onFocus={edge ? () => setFocused(true) : undefined}
                        onBlur={edge ? () => setFocused(false) : undefined}
                        onClick={(e) => {
                                // stopPropagation keeps the parent's own onClick from
                                // opening the detail panel on a copy click.
                                e.stopPropagation();
                                void copyTextToClipboard(taskId).then(() => {
                                        setCopied(true);
                                        if (timer.current)
                                                clearTimeout(timer.current);
                                        timer.current = setTimeout(
                                                () => setCopied(false),
                                                1200,
                                        );
                                });
                        }}
                >
                        {copied ? (
                                <Check style={{ width: 12, height: 12 }} />
                        ) : (
                                <Copy style={{ width: 12, height: 12 }} />
                        )}
                </button>
        );
}
