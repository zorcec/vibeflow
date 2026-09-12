import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { ModalBase } from './ModalBase';

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
    if (e.key === 'Enter') onConfirm();
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
          <button
            id="confirm-modal-cancel"
            onClick={onCancel}
            disabled={loading}
            style={{ padding: '7px 16px', borderRadius: 8, background: 'var(--t-hover)', border: '1px solid var(--t-border)', color: 'var(--t-text-muted)', fontSize: 13, cursor: 'pointer', transition: 'background 0.15s' }}
          >{cancelLabel}</button>
          <button
            id="confirm-modal-confirm"
            onClick={onConfirm}
            disabled={loading}
            style={{ padding: '7px 16px', borderRadius: 8, background: 'var(--t-danger-strong)', border: 'none', color: 'var(--t-white)', fontSize: 13, fontWeight: 600, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1, transition: 'background 0.15s' }}
          >{loading ? 'Deleting…' : confirmLabel}</button>
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
