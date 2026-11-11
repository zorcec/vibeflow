import { Children, type ReactElement, type ReactNode } from "react";
import { Popover as BasePopover } from "@base-ui-components/react/popover";
import { cn } from "../primitives";

/**
 * Popover — anchored floating content.
 *
 * Behaviour (dismissal, focus management, collision-aware positioning) comes
 * from Base UI's Popover. This component owns presentation and the API the
 * board needs.
 *
 * `container` is not decoration: the overlay renders inside a shadow root, and
 * a popover portalled to `document.body` would leave the overlay's token scope
 * (the same contract Dialog has). `side`/`align` are exposed because the child
 * popover and the filter menu both flip at the viewport edge, and Edge-case
 * flipping is Base UI's job — not something a caller should re-implement.
 */
export type PopoverSide = "top" | "right" | "bottom" | "left";
export type PopoverAlign = "start" | "center" | "end";

export interface PopoverProps {
  /** Element that opens the popover. Rendered inside Base UI's trigger button. */
  trigger: ReactNode;
  /** Controlled open state. */
  open: boolean;
  /** Called when the popover opens or closes (Escape, outside click, focus out). */
  onOpenChange: (open: boolean) => void;
  /** Preferred side; Base UI flips when there is no room. */
  side?: PopoverSide;
  /** Alignment along the chosen side. */
  align?: PopoverAlign;
  /** Portal target. Defaults to `document.body`; the overlay passes its shadow root. */
  container?: HTMLElement | null;
  /** Popover content. */
  children: ReactNode;
  /**
   * Accessible name for the popup. Base UI renders the popup with
   * `role="dialog"`, and a nameless dialog is an axe *serious* violation
   * (`aria-dialog-name`) as well as a real screen-reader dead end. Override it
   * with what the popover actually contains.
   */
  label?: string;
  /** Extra classes for the popup surface. */
  className?: string;
}

export function Popover({
  trigger,
  open,
  onOpenChange,
  side = "bottom",
  align = "center",
  container,
  children,
  label = "Popover",
  className,
}: PopoverProps) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      {/* `render` keeps the caller's element as THE trigger — wrapping it in a
          Base UI button would produce a button inside a button. */}
      <BasePopover.Trigger
        render={Children.only(trigger) as ReactElement}
        data-role="popover-trigger"
      />
      <BasePopover.Portal container={container ?? undefined}>
        <BasePopover.Positioner side={side} align={align} sideOffset={6}>
          <BasePopover.Popup
            aria-label={label}
            data-role="popover-popup"
            className={cn(
              "z-50 max-w-sm rounded-lg border border-border bg-bg-raised p-3 text-sm text-text shadow-popover",
              className,
            )}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
