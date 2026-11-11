import { useEffect, useRef, type TextareaHTMLAttributes } from "react";
import { cn, cva } from "../primitives";

/**
 * Textarea — the multi-line text-entry primitive.
 *
 * Same contract as `Input`: token utilities only, no raw colours, no arbitrary
 * values, all props forwarded to the real `<textarea>`.
 *
 * AUTO-EXPAND reuses the logic the board and the overlay already rely on
 * (`packages/ui/src/AutoExpandTextarea.tsx`): set the height to `auto`, then to
 * `scrollHeight`, so the box grows with the content instead of scrolling. The
 * legacy component is deliberately NOT deleted in this phase — it keeps working
 * until P14.4 rebuilds its consumers, and this primitive is what they migrate to.
 */
const textareaStyles = cva(
  "w-full rounded-md border bg-bg px-3 py-1.5 text-sm text-text placeholder:text-text-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-bg-raised",
  {
    variants: {
      state: {
        default: "border-border",
        error: "border-danger",
      },
      /** Manual resize behaviour. `none` pairs with `autoExpand`. */
      resize: {
        none: "resize-none",
        vertical: "resize-y",
        both: "resize",
      },
    },
    defaultVariants: { state: "default", resize: "vertical" },
  },
);

export type TextareaState = "default" | "error";
export type TextareaResize = "none" | "vertical" | "both";

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Error message. Present ⇒ `aria-invalid` + `aria-describedby`. */
  error?: string;
  /** Grow with content instead of scrolling. Implies `resize="none"` unless set. */
  autoExpand?: boolean;
  /** Manual resize handle. Defaults to `none` when `autoExpand` is on. */
  resize?: TextareaResize;
  className?: string;
}

export function Textarea({
  error,
  autoExpand = false,
  resize,
  className,
  id,
  rows = 3,
  value,
  onChange,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}: TextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const errorId = error && id ? `${id}-error` : undefined;
  const invalid = error ? true : ariaInvalid;
  const describedBy =
    [ariaDescribedBy, errorId].filter(Boolean).join(" ") || undefined;
  const effectiveResize: TextareaResize = resize ?? (autoExpand ? "none" : "vertical");

  // Re-measure whenever the controlled value changes, so a programmatic set
  // (or a paste) grows the box exactly like typing does.
  useEffect(() => {
    if (!autoExpand) return;
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [autoExpand, value]);

  const textarea = (
    <textarea
      ref={ref}
      id={id}
      rows={rows}
      value={value}
      className={cn(
        textareaStyles({
          state: error ? "error" : "default",
          resize: effectiveResize,
        }),
        className,
      )}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => {
        onChange?.(event);
        if (!autoExpand) return;
        const el = event.currentTarget;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
      }}
      {...rest}
    />
  );

  if (!error) return textarea;
  return (
    <div className="flex flex-col gap-1">
      {textarea}
      <p id={errorId} data-role="textarea-error" className="text-xs text-danger">
        {error}
      </p>
    </div>
  );
}
