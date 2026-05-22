import React from 'react';
import type { FileEntry } from '../../types';
import { formatFileSize } from '../../utils';
import { formatDate } from '../../utils';

function fileIcon(f: FileEntry): string {
  if (f.linkedPath) return '🔗';
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(f.name)) return '🖼️';
  if (/\.html?$/i.test(f.name)) return '🌐';
  if (/\.md$/i.test(f.name)) return '📄';
  if (/\.pdf$/i.test(f.name)) return '📄';
  return '📎';
}

function isPreviewable(f: FileEntry): boolean {
  return /\.(png|jpe?g|gif|webp|svg|html?)$/i.test(f.name);
}

function isHtmlFile(f: FileEntry): boolean {
  return /\.html?$/i.test(f.name);
}

interface FileItemProps {
  file: FileEntry;
  url: string;
  /** 'normal' = full-size card with size label (Files tab). 'compact' = minimal row (Activities pane). */
  variant: 'normal' | 'compact';
  onPreview?: (f: FileEntry, url: string) => void;
  onDelete?: (f: FileEntry) => Promise<void> | void;
}

export function FileItem({ file: f, url, variant, onPreview, onDelete }: FileItemProps) {
  const canPreview = isPreviewable(f);
  const isHtml = isHtmlFile(f);

  function handlePreview() {
    if (onPreview) {
      onPreview(f, url);
    } else {
      window.open(url, '_blank');
    }
  }

  if (variant === 'compact') {
    return (
      <div
        className="group/file-compact"
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 8, background: 'var(--p-card)', border: '1px solid var(--p-border)', position: 'relative' }}
      >
        <span style={{ fontSize: 14, flexShrink: 0 }}>{fileIcon(f)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <button
            onClick={handlePreview}
            style={{ fontSize: 12, color: 'var(--p-blue-300)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}
            title={f.name}
          >{f.name}</button>
        </div>
        <span className="file-compact-ts" style={{ fontSize: 10, color: 'var(--p-border-t)', flexShrink: 0, marginLeft: 2 }}>
          {f.createdAt ? formatDate(f.createdAt) : 'attached'}
        </span>
        <div
          className="file-compact-actions"
          style={{ position: 'absolute', right: 6, top: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: 4, transition: 'opacity 0.15s', background: 'var(--p-card)', paddingLeft: 8 }}
        >
          {canPreview && (
            <button
              onClick={handlePreview}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 4, fontSize: 11, color: 'var(--p-text-m)' }}
              title={isHtml ? 'Open in new tab' : 'Preview'}
            >{isHtml ? '↗' : '👁'}</button>
          )}
          <a
            href={url}
            download={f.name}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 4, fontSize: 11, color: 'var(--p-text-m)', textDecoration: 'none' }}
            title="Download"
            onClick={(e) => e.stopPropagation()}
          >↓</a>
          {onDelete && (
            <button
              onClick={() => void onDelete(f)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 4, fontSize: 11, color: 'var(--p-text-m)' }}
              title="Delete"
            >✕</button>
          )}
        </div>
      </div>
    );
  }

  // normal variant
  return (
    <div
      className="group/file"
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 8, borderRadius: 8, border: '1px solid var(--p-border)', transition: 'background 0.15s', position: 'relative' }}
    >
      <span style={{ fontSize: 18, flexShrink: 0 }}>{fileIcon(f)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{ fontSize: 12, fontWeight: 500, color: 'var(--p-text)', margin: 0, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={f.name}
          onClick={handlePreview}
        >{f.name}</p>
        <p style={{ fontSize: 10, color: 'var(--p-text-f)', margin: 0 }}>
          {f.linkedPath ? `linked: ${f.linkedPath}` : formatFileSize(f.size ?? 0)}
        </p>
      </div>
      <div className="file-normal-actions" style={{ display: 'flex', alignItems: 'center', gap: 4, transition: 'opacity 0.15s' }}>
        {canPreview && (
          <button
            onClick={handlePreview}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', borderRadius: 4, fontSize: 11, color: 'var(--p-text-m)' }}
            title={isHtml ? 'Open in new tab' : 'Preview'}
          >{isHtml ? '↗' : '👁'}</button>
        )}
        <a
          href={url}
          download={f.name}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', borderRadius: 4, fontSize: 11, color: 'var(--p-text-m)', textDecoration: 'none' }}
          title="Download"
          onClick={(e) => e.stopPropagation()}
        >↓</a>
        {onDelete && (
          <button
            onClick={() => void onDelete(f)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', borderRadius: 4, fontSize: 11, color: 'var(--p-text-m)' }}
            title="Delete"
          >✕</button>
        )}
      </div>
    </div>
  );
}
