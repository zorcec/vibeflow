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
 * panel does not have to be opened just to read it. Hidden until the parent
 * row/card is hovered (or the button is keyboard-focused) — see .card-copy-id
 * in kanban.css — so the face stays clean. Swaps to a check for 1.2s as
 * copy feedback. Rendered nested inside the row/card root button (the same
 * precedent as the tree's Unlink button), so stopPropagation on
 * mousedown+click keeps the parent's own onClick from firing.
 */
export function CopyIdButton({
        taskId,
        className,
}: {
        taskId: string;
        /** Extra modifier class, e.g. "card-copy-id--child" for child rows. */
        className?: string;
}) {
        const [copied, setCopied] = React.useState(false);
        const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        React.useEffect(
                () => () => {
                        if (timer.current) clearTimeout(timer.current);
                },
                [],
        );
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
                        // Visual styling (box, lit hover background, colour) lives entirely
                        // in .card-copy-id in kanban.css so it lights up like the tree
                        // toggle chip. No inline background/colour here — an inline
                        // `background: transparent` outranks the :hover rule and kills
                        // the lit pill.
                        onMouseDown={(e) => e.stopPropagation()}
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
                                <Check style={{ width: 9, height: 9 }} />
                        ) : (
                                <Copy style={{ width: 9, height: 9 }} />
                        )}
                </button>
        );
}
