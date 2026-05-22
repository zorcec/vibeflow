import React from 'react';
import type { FileEntry } from '../../types';
import { ConfirmModal } from '../ConfirmModal';
import { FileItem } from './FileItem';

interface Props {
  files: FileEntry[];
  loading: boolean;
  error: string | null;
  baseUrl: string;
  onPreview: (f: FileEntry) => void;
  onDelete?: (f: FileEntry) => Promise<void>;
}

export function FilesList({ files, loading, error, baseUrl, onPreview, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = React.useState<FileEntry | null>(null);

  if (loading) {
    return <p style={{ color: 'var(--p-text-g)', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>Loading…</p>;
  }
  if (error) {
    return <p style={{ color: 'var(--p-red-500)', fontSize: 12, textAlign: 'center', padding: '8px 0' }}>Failed to load.</p>;
  }
  if (files.length === 0) {
    return <p style={{ color: 'var(--p-text-g)', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>No files attached.</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {files.map((f) => {
        const url = f.url ?? `${baseUrl}/api/files/${encodeURIComponent(f.name)}`;
        return (
          <FileItem
            key={f.name}
            file={f}
            url={url}
            variant="normal"
            onPreview={(file) => onPreview(file)}
            onDelete={onDelete ? (file) => { setConfirmDelete(file); return Promise.resolve(); } : undefined}
          />
        );
      })}

      {onDelete && (
        <ConfirmModal
          open={confirmDelete !== null}
          message={confirmDelete ? `Delete "${confirmDelete.name}"? This action cannot be undone.` : ''}
          onConfirm={() => {
            if (confirmDelete) void onDelete(confirmDelete);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
