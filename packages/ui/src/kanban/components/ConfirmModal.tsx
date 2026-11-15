import React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { ModalBase } from './ModalBase';
import { Button } from '../../primitives';

interface Props {
  open: boolean;
  message: React.ReactNode;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ open, message, title = 'Confirm', confirmLabel = 'Delete', cancelLabel = 'Cancel', loading, error, onConfirm, onCancel }: Props) {
  const handleKeyDown = React.useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    // Focus-Cancel + Enter must NOT confirm: a window-global Enter turns
    // the focused Cancel button into Delete. Confirm only when the confirm
    // button itself is focused, or when focus sits outside buttons entirely
    // (body/modal text) — never from Cancel or any other button.
    const active = document.activeElement as HTMLElement | null;
    if (active && active.tagName === 'BUTTON' && active.id !== 'confirm-modal-confirm') return;
    onConfirm();
  }, [onConfirm]);

  return (
    <ModalBase
      open={open}
      onClose={onCancel}
      id="confirm-modal"
      width="min(380px, 95vw)"
      icon={<AlertTriangle style={{ width: 20, height: 20, color: 'var(--t-danger)' }} />}
      title={title}
      onKeyDown={handleKeyDown}
      footer={
        <>
          <Button
            id="confirm-modal-cancel"
            variant="secondary"
            size="sm"
            onClick={onCancel}
            disabled={loading}
            style={{ padding: '7px 16px', borderRadius: 8, background: 'var(--t-hover)', border: '1px solid var(--t-border)', color: 'var(--t-text-muted)', fontSize: 13 }}
          >{cancelLabel}</Button>
          <Button
            id="confirm-modal-confirm"
            variant="danger"
            size="sm"
            onClick={onConfirm}
            disabled={loading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, background: 'var(--t-danger-strong)', border: 'none', color: 'var(--t-white)', fontSize: 13, fontWeight: 600, opacity: loading ? 0.6 : 1 }}
          >{loading && <Loader2 aria-hidden="true" size={14} style={{ animation: 'spin 0.7s linear infinite' }} />}{loading ? 'Deleting…' : confirmLabel}</Button>
        </>
      }
    >
      <div style={{ padding: '16px 18px' }}>
        {typeof message === 'string'
          ? <p style={{ margin: 0, fontSize: 13, color: 'var(--t-text-faint)', lineHeight: 1.6 }}>{message}</p>
          : message}
        {error && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--t-danger)' }}>{error}</p>}
      </div>
    </ModalBase>
  );
}
