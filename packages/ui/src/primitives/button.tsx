import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn, cva, type VariantProps } from "../primitives";

/**
 * Button — the primary clickable primitive (ADR-governed token contract:
 * every colour/surface resolves through `src/primitives/theme.css`, so all
 * six themes restyle the button with no per-theme markup).
 */
const buttonStyles = cva(
  "inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "border-accent bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-strong",
        secondary:
          "border-border-strong bg-bg-raised text-text hover:bg-hover active:bg-control-surface",
        ghost:
          "border-transparent bg-transparent text-text hover:bg-hover active:bg-control-surface",
        danger:
          "border-danger bg-danger-soft text-danger hover:bg-danger hover:text-white active:bg-danger-strong active:text-white",
      },
      size: {
        sm: "px-2.5 py-1 text-xs",
        md: "px-4 py-1.5 text-sm",
        lg: "px-5 py-2 text-base",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonVariant = VariantProps<typeof buttonStyles>["variant"];
export type ButtonSize = VariantProps<typeof buttonStyles>["size"];

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "disabled"> {
  /** Visual variant. Every key here needs a story (see STORY_MATRIX). */
  variant?: ButtonVariant;
  /** Control height / text size. Every key here needs a story (see STORY_MATRIX). */
  size?: ButtonSize;
  /** When true the button shows a spinner, reports `aria-busy`, and blocks activation. */
  loading?: boolean;
  /** Native disabled state. Combined with `loading` — either blocks activation. */
  disabled?: boolean;
  /** Button content — also the accessible name when text. */
  children: ReactNode;
  /** Native button type. Defaults to `"button"` so bare buttons never submit forms. */
  type?: ButtonHTMLAttributes<HTMLButtonElement>["type"];
  /** Extra classes, merged last via `cn`. */
  className?: string;
}

export function Button({
  variant,
  size,
  loading = false,
  disabled = false,
  children,
  type = "button",
  className,
  onClick,
  ...rest
}: ButtonProps) {
  const blocked = disabled || loading;
  return (
    <button
      type={type}
      className={cn(buttonStyles({ variant, size }), className)}
      disabled={blocked}
      aria-busy={loading || undefined}
      onClick={(event) => {
        if (blocked) return;
        onClick?.(event);
      }}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden="true"
          data-testid="Button-spinner"
          className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}
