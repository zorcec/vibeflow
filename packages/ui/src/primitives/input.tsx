import { forwardRef, type InputHTMLAttributes } from "react";
import { cn, cva } from "../primitives";

/**
 * Input — the single-line text-entry primitive.
 *
 * Contract (AGENTS.md): token utilities only, no raw colours, no arbitrary
 * values, all props forwarded to the real `<input>`.
 *
 * ERROR CONTRACT: `error` is a message, not a boolean. Supplying it sets
 * `aria-invalid="true"` and points `aria-describedby` at the rendered message,
 * so a screen reader announces the reason — the thing axe and real users
 * actually need. The message is only rendered when there is something to say.
 */
const inputStyles = cva(
  "w-full rounded-md border bg-bg px-3 py-1.5 text-sm text-text placeholder:text-text-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-bg-raised",
  {
    variants: {
      /** Visual state. `error` is also expressed purely in tokens. */
      state: {
        default: "border-border",
        error: "border-danger",
      },
    },
    defaultVariants: { state: "default" },
  },
);

export type InputState = "default" | "error";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** `text | email | password | search | number` — narrowed so no exotic type sneaks in. */
  type?: "text" | "email" | "password" | "search" | "number";
  /** Error message. Present ⇒ `aria-invalid` + `aria-describedby`. */
  error?: string;
  /** Extra classes for the input itself, merged last via `cn`. */
  className?: string;
}

/**
 * Ref forwarding (P13.2): callers that keep a `RefObject` for focus
 * management — the kanban board search field — must reach the real
 * `<input>`; without it React drops the ref and `focus()` silently no-ops.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({
  type = "text",
  error,
  className,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...rest
}, ref) {
  const errorId = error && id ? `${id}-error` : undefined;
  const invalid = error ? true : ariaInvalid;
  const describedBy =
    [ariaDescribedBy, errorId].filter(Boolean).join(" ") || undefined;

  const input = (
    <input
      ref={ref}
      id={id}
      type={type}
      className={cn(inputStyles({ state: error ? "error" : "default" }), className)}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      {...rest}
    />
  );

  // The message lives in the same subtree as the input so `aria-describedby`
  // always resolves; without an error the primitive renders ONLY the input, so
  // it drops into existing layouts without adding a wrapper.
  if (!error) return input;
  return (
    <div className="flex flex-col gap-1">
      {input}
      <p
        id={errorId}
        data-role="input-error"
        className="text-xs text-danger"
      >
        {error}
      </p>
    </div>
  );
});
