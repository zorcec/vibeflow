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
      icon={<AlertTriangle style={{ width: 20, height: 20, color: '#f87171' }} />}
      title={title}
      onKeyDown={handleKeyDown}
      footer={
        <>
          <button
            id="confirm-modal-cancel"
            onClick={onCancel}
            disabled={loading}
            style={{ padding: '7px 16px', borderRadius: 8, background: 'var(--p-hover)', border: '1px solid var(--p-border)', color: 'var(--p-text-m)', fontSize: 13, cursor: 'pointer', transition: 'background 0.15s' }}
          >{cancelLabel}</button>
          <button
            id="confirm-modal-confirm"
            onClick={onConfirm}
            disabled={loading}
            style={{ padding: '7px 16px', borderRadius: 8, background: '#dc2626', border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1, transition: 'background 0.15s' }}
          >{loading ? 'Deleting…' : confirmLabel}</button>
        </>
      }
    >
      <div style={{ padding: '16px 18px' }}>
        {typeof message === 'string'
          ? <p style={{ margin: 0, fontSize: 13, color: 'var(--p-text-f)', lineHeight: 1.6 }}>{message}</p>
          : message}
        {error && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--p-red)' }}>{error}</p>}
      </div>
    </ModalBase>
  );
}
