import { cn, cva, type VariantProps } from "../primitives";

/**
 * Template widget (design-system P8) — the smallest correct component.
 * Every scaffolded component starts as a copy of this file with
 * `TemplateWidget` renamed, so fixes here propagate to all future
 * components. Real code, not a sketch: typechecked by `tsc --noEmit` and
 * exercised by the test beside it.
 */
const widgetStyles = cva(
  "inline-flex items-center rounded-md border px-3 py-1 text-sm font-medium",
  {
    variants: {
      tone: {
        quiet: "border-border bg-bg text-text",
        loud: "border-accent bg-accent-soft text-text",
      },
    },
    defaultVariants: { tone: "quiet" },
  },
);

export interface TemplateWidgetProps {
  /** Visible label — also the button's accessible name. */
  label: string;
  /** Visual tone. Every key here needs a story (see STORY_MATRIX). */
  tone?: VariantProps<typeof widgetStyles>["tone"];
  /** Called with `label` when the action is clicked. */
  onAction: (label: string) => void;
  /** Extra classes, merged last via `cn`. */
  className?: string;
}

export function TemplateWidget({
  label,
  tone,
  onAction,
  className,
}: TemplateWidgetProps) {
  return (
    <button
      type="button"
      data-testid="TemplateWidget-action"
      className={cn(widgetStyles({ tone }), className)}
      onClick={() => onAction(label)}
    >
      {label}
    </button>
  );
}
