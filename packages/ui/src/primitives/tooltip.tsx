import React from "react";
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Tooltip as BaseTooltip } from "@base-ui-components/react/tooltip";
import { cn } from "../primitives";

/**
 * Tooltip — a hover/focus hint.
 *
 * WHY OPEN STATE IS CONTROLLED HERE
 * Base UI's Tooltip opens on keyboard focus but not on hover in this version
 * (measured 2026-11-11 with both `userEvent.hover` and explicit pointer events,
 * in jsdom and in the real browser story runner). A hint that only appears for
 * keyboard users is half a hint, so the pointer and focus behaviour is driven
 * explicitly here and Base UI keeps the parts it does well: the positioner, the
 * portal, and the accessibility wiring we extend below.
 *
 * DISABLED TRIGGERS: a disabled control cannot receive focus, so a tooltip
 * attached to one can never be reached by a keyboard user. Rather than render an
 * unreachable hint, `disabled` renders the trigger alone — and the tests pin
 * that, because "we show a tooltip on a disabled button" is a trap that looks
 * helpful and is not.
 */
export type TooltipSide = "top" | "right" | "bottom" | "left";

export interface TooltipProps {
  /** Hint text. */
  content: ReactNode;
  /** Element the hint describes. Must be a single element. */
  children: ReactNode;
  /** Preferred side; Base UI flips when there is no room. */
  side?: TooltipSide;
  /** Milliseconds before showing on hover. Focus shows immediately. */
  delay?: number;
  /** Portal target. Defaults to `document.body`; the overlay passes its shadow root. */
  container?: HTMLElement | null;
  /** Skip the tooltip entirely (see the note above). */
  disabled?: boolean;
  /** Extra classes for the popup surface. */
  className?: string;
}

export function Tooltip({
  content,
  children,
  side = "top",
  delay = 300,
  container,
  disabled = false,
  className,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  /** Pending hover-open timer. A ref, not a render-scoped `let`: a re-render
   *  would orphan the old closure's timer, which then opens the tooltip after
   *  the pointer left — and nothing would ever clear it on unmount. */
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Read the ref at unmount time, not at mount: the timer only exists
    // after a pointerenter.
    return () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    };
  }, []);

  if (disabled) return <>{children}</>;
  // Validate BEFORE Children.only: that helper throws React's own generic
  // message, which tells a caller nothing about what Tooltip needs.
  if (Children.count(children) !== 1 || !isValidElement(children)) {
    throw new Error("Tooltip: children must be a single element");
  }

  // OWN the aria contract: Base UI wires the popup but leaves the trigger
  // without `aria-describedby` (measured), and a hint that is not described to
  // the accessibility tree is not a hint.
  const child = children as ReactElement<Record<string, unknown>>;
  const childProps = child.props as {
    onPointerEnter?: (e: unknown) => void;
    onPointerLeave?: (e: unknown) => void;
    onFocus?: (e: unknown) => void;
    onBlur?: (e: unknown) => void;
  };

  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  const openSoon = () => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setOpen(true);
    }, delay);
  };
  const closeNow = () => {
    clearHoverTimer();
    setOpen(false);
  };

  const trigger = cloneElement(child, {
    "aria-describedby": tooltipId,
    onPointerEnter: (e: unknown) => {
      childProps.onPointerEnter?.(e);
      openSoon();
    },
    onPointerLeave: (e: unknown) => {
      childProps.onPointerLeave?.(e);
      closeNow();
    },
    onFocus: (e: unknown) => {
      childProps.onFocus?.(e);
      // Keyboard users get the hint immediately — no artificial delay.
      clearHoverTimer();
      setOpen(true);
    },
    onBlur: (e: unknown) => {
      childProps.onBlur?.(e);
      closeNow();
    },
  } as Record<string, unknown>);

  return (
    <BaseTooltip.Provider delay={delay}>
      <BaseTooltip.Root open={open} onOpenChange={setOpen}>
        {/* `render` makes the CALLER's element the trigger. Wrapping it in a
            Base UI <button> would nest a button inside a button — invalid HTML
            that also gives assistive tech two controls for one action. */}
        <BaseTooltip.Trigger render={trigger} data-role="tooltip-trigger" />
        <BaseTooltip.Portal container={container ?? undefined}>
          <BaseTooltip.Positioner side={side} sideOffset={6}>
            <BaseTooltip.Popup
              // Base UI wires aria-describedby but emits NO role on the popup
              // (measured: data-role only). role="tooltip" is the semantic the
              // requirement names, so state it explicitly.
              role="tooltip"
              id={tooltipId}
              data-role="tooltip-popup"
              className={cn(
                "z-50 rounded-md border border-border bg-bg-raised px-2 py-1 text-xs text-text shadow-popover",
                className,
              )}
            >
              {content}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}
