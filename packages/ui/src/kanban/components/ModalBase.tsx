'use client';
import React from 'react';
import { createPortal } from 'react-dom';

interface ModalBaseProps {
  open: boolean;
  onClose: () => void;
  /** Header icon rendered inline with title. */
  icon?: React.ReactNode;
  title?: string;
  /** Extra elements on the right side of the header (e.g. close button). */
  headerActions?: React.ReactNode;
  /** Width override for the modal box. Default: min(420px, 95vw). */
  width?: string;
  /** Max height of the modal box. */
  maxHeight?: string;
  /** Optional id for the backdrop. */
  id?: string;
  children: React.ReactNode;
  /** Footer content. Rendered in a bottom bar with top border. */
  footer?: React.ReactNode;
  /** Additional inline styles for the modal box. */
  boxStyle?: React.CSSProperties;
  /** Extra keyboard handler (e.g. Enter to confirm). */
  onKeyDown?: (e: KeyboardEvent) => void;
}

export function ModalBase({ open, onClose, icon, title, headerActions, width, maxHeight, id, children, footer, boxStyle, onKeyDown }: ModalBaseProps) {
  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      onKeyDown?.(e);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, onKeyDown]);

  if (!open) return null;

  const hasHeader = !!(icon || title || headerActions);

  const modal = (
    <div
      id={id}
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="modal-box" style={{ width: width ?? 'min(420px, 95vw)', maxHeight, ...boxStyle }}>
        {hasHeader && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--p-border)', flexShrink: 0 }}>
            {icon && <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>{icon}</span>}
            {title && <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--p-text)', flex: 1, minWidth: 0 }}>{title}</span>}
            {headerActions && <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: 'auto' }}>{headerActions}</div>}
          </div>
        )}
        {children}
        {footer && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '10px 18px', borderTop: '1px solid var(--p-border)', flexShrink: 0 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
