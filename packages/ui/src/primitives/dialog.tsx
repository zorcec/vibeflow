import type { CSSProperties, ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";
import { cn } from "../primitives";

/**
 * Dialog — the modal primitive.
 *
 * Behaviour comes from Base UI's Dialog (focus trap, focus restore, Escape,
 * `aria-modal`, scroll lock). Hand-rolling any of that is how modals end up
 * keyboard-trapping users inside a page they cannot leave, so this component
 * deliberately owns no behaviour of its own — only the token-only presentation
 * and the API the board and overlay need.
 *
 * `container` exists because the overlay renders inside a shadow root: a modal
 * portalled to `document.body` would escape the overlay's tokens and styles.
 * Passing the shadow root keeps it inside (this is P7's isolation contract).
 */
export interface DialogProps {
  /** Controlled open state. */
  open: boolean;
  /** Called with `false` on Escape, outside click (when enabled) and Close. */
  onOpenChange: (open: boolean) => void;
  /** Required heading — the dialog's accessible name. */
  title: string;
  /** Optional supporting text, wired to `aria-describedby`. */
  description?: string;
  /** Portal target. Defaults to `document.body`; the overlay passes its shadow root. */
  container?: HTMLElement | null;
  /** Body content. */
  children: ReactNode;
  /** Action row rendered at the bottom, right-aligned. */
  footer?: ReactNode;
  /** Outside click closes. Default true; a destructive confirm usually wants false. */
  closeOnOutsideClick?: boolean;
  /** Extra classes for the popup surface. */
  className?: string;
  /** Element id for the popup — callers that deep-link or query a modal keep their hook. */
  id?: string;
  /** Optional icon rendered inline before the title. */
  icon?: ReactNode;
  /** Extra controls on the right of the title row (e.g. a close button). */
  headerActions?: ReactNode;
  /** Inline style for the popup (width / max-height overrides). */
  style?: CSSProperties;
  /** Extra classes for the backdrop (composites that keep a legacy class contract). */
  backdropClassName?: string;
  /** Extra classes for the scrollable body, for layouts that manage their own flow. */
  bodyClassName?: string;
  /** Inline style for the scrollable body. */
  bodyStyle?: CSSProperties;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  container,
  children,
  footer,
  closeOnOutsideClick = true,
  className,
  id,
  icon,
  headerActions,
  style,
  bodyClassName,
  bodyStyle,
  backdropClassName,
}: DialogProps) {
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      modal
      disablePointerDismissal={!closeOnOutsideClick}
    >
      <BaseDialog.Portal container={container ?? undefined}>
        <BaseDialog.Backdrop
          data-role="dialog-backdrop"
          className={cn("fixed inset-0 z-40 bg-overlay-scrim", backdropClassName)}
        />
        <BaseDialog.Popup
          // Base UI marks the background inert but does NOT emit aria-modal
          // (measured 2026-11-11: the popup's attributes were role=dialog +
          // aria-labelledby only). The requirement is explicit, so state it.
          aria-modal="true"
          id={id}
          data-role="dialog-popup"
          style={style}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-dvh w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-hidden rounded-lg border border-border bg-bg-raised p-5 shadow-card",
            className,
          )}
        >
          <div className="flex items-center gap-2.5">
            {icon ? <span className="flex shrink-0 items-center">{icon}</span> : null}
            <BaseDialog.Title className="flex-1 text-base font-semibold text-text">
              {title}
            </BaseDialog.Title>
            {headerActions ? (
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {headerActions}
              </div>
            ) : null}
          </div>
          {description ? (
            <BaseDialog.Description className="text-sm text-text-muted">
              {description}
            </BaseDialog.Description>
          ) : null}
          {/* tabIndex: axe `scrollable-region-focusable` — a scrollable box that
              cannot take keyboard focus strands keyboard users on long content. */}
          <div
            tabIndex={0}
            style={bodyStyle}
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overscroll-contain text-sm text-text",
              bodyClassName,
            )}
          >
            {children}
          </div>
          {footer ? (
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              {footer}
            </div>
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
