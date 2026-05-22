import React from 'react';
import type { Comment, FileEntry } from '../../types';
import { MarkdownPreview } from './MarkdownPreview';
import { AutoExpandTextarea } from './AutoExpandTextarea';
import { ConfirmModal } from '../ConfirmModal';
import { formatDate } from '../../utils';
import { FileItem } from './FileItem';

interface ChangeActivityItem {
  kind: 'change';
  sortKey: string;
  field: string;
  from: string;
  to: string;
  actor: string;
  source?: 'cli' | 'web';
}

interface FileActivityItem {
  kind: 'file';
  sortKey: string;
  file: FileEntry;
  url: string;
}

interface CommentActivityItem {
  kind: 'comment';
  sortKey: string;
  comment: Comment;
}

interface LifecycleActivityItem {
  kind: 'lifecycle';
  sortKey: string;
  label: string;
  icon: string;
  author?: string;
}

type ActivityItem = FileActivityItem | CommentActivityItem | LifecycleActivityItem | ChangeActivityItem;

/** Minimalistic source indicator (CLI terminal icon) */
function SourceBadge({ source }: { source?: 'cli' | 'web' }) {
  if (source !== 'cli') return null;
  return (
    <span title="Via CLI (agent)" style={{ fontSize: 9, color: 'var(--p-green-300)', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 4, padding: '0 4px', fontFamily: 'monospace', lineHeight: '16px', flexShrink: 0 }}>
      &gt;_
    </span>
  );
}

/** Groups of consecutive activity items by the same author */
interface ActivityGroup {
  author: string | null;  // null means no author (solo item, no header)
  newestSortKey: string;
  oldestSortKey: string;
  items: ActivityItem[];
}

/** Extract the groupable author key from an activity item, or null for solo items */
function getItemAuthor(item: ActivityItem, gitUserName: string): string | null {
  if (item.kind === 'lifecycle') return item.author ?? null;
  if (item.kind === 'comment') {
    const c = item.comment;
    if (c.type === 'system') return null;
    return c.author === 'agent' ? '🤖 Agent' : (c.authorName ?? gitUserName);
  }
  if (item.kind === 'change') return item.actor;
  return null; // files: solo
}

/** Build consecutive groups from sorted activity list */
function buildGroups(activity: ActivityItem[], gitUserName: string): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const item of activity) {
    const author = getItemAuthor(item, gitUserName);
    const last = groups[groups.length - 1];
    if (author && last && last.author === author) {
      last.items.push(item);
      if (item.sortKey > last.newestSortKey) last.newestSortKey = item.sortKey;
      if (item.sortKey < last.oldestSortKey) last.oldestSortKey = item.sortKey;
    } else {
      groups.push({ author, newestSortKey: item.sortKey, oldestSortKey: item.sortKey, items: [item] });
    }
  }
  return groups;
}

export interface LocalChange {
  field: string;
  from: string;
  to: string;
  actor: string;
  timestamp: string;
  source?: 'cli' | 'web';
}

interface Props {
  comments: Comment[];
  files?: FileEntry[];
  localChanges?: LocalChange[];
  loading: boolean;
  error: string | null;
  gitUserName?: string;
  taskAuthorName?: string;
  baseUrl?: string;
  taskId?: string;
  taskCreatedAt?: string;
  taskUpdatedAt?: string;
  onEdit: (comment: Comment, newText: string) => Promise<void>;
  onDelete: (comment: Comment) => Promise<void>;
  onDeleteFile?: (f: FileEntry) => Promise<void>;
  onFilePreview?: (name: string, url: string) => void;
}

export function CommentsList({ comments, files = [], localChanges = [], loading, error, gitUserName = 'You', taskAuthorName, baseUrl = '', taskId, taskCreatedAt, taskUpdatedAt, onEdit, onDelete, onDeleteFile, onFilePreview }: Props) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const editTextareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editText, setEditText] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState<Comment | null>(null);
  const [confirmDeleteFile, setConfirmDeleteFile] = React.useState<FileEntry | null>(null);
  const [showUpdates, setShowUpdates] = React.useState<boolean>(() => {
    try { return localStorage.getItem('vibeflow-show-updates') !== 'false'; } catch { return true; }
  });
  const prevLoadingRef = React.useRef(loading);

  // Build unified chronological activity stream: lifecycle events + comments + files + local changes
  const activity: ActivityItem[] = React.useMemo(() => {
    const items: ActivityItem[] = [];
    if (taskCreatedAt) items.push({ kind: 'lifecycle', sortKey: taskCreatedAt, label: 'Task created', icon: '✦', author: taskAuthorName ?? gitUserName });
    if (taskUpdatedAt && taskUpdatedAt !== taskCreatedAt) items.push({ kind: 'lifecycle', sortKey: taskUpdatedAt, label: 'Task edited', icon: '✎' });
    const commentItems: ActivityItem[] = comments.map(c => ({ kind: 'comment' as const, sortKey: c.createdAt, comment: c }));
    const fileItems: ActivityItem[] = files.map(f => {
      const fileUrl = f.url.startsWith('http') ? f.url : `${baseUrl}${f.url}`;
      return { kind: 'file' as const, sortKey: f.createdAt ?? '9999', file: f, url: fileUrl };
    });
    const changeItems: ActivityItem[] = localChanges.map(c => ({
      kind: 'change' as const, sortKey: c.timestamp, field: c.field, from: c.from, to: c.to, actor: c.actor, source: c.source,
    }));
    return [...items, ...commentItems, ...fileItems, ...changeItems].sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }, [comments, files, localChanges, baseUrl, taskCreatedAt, taskUpdatedAt]);

  const updateCount = React.useMemo(
    () => activity.filter(item => item.kind === 'lifecycle' || item.kind === 'change').length,
    [activity],
  );

  // Hide lifecycle/change items by default; user can toggle to reveal them
  const visibleActivity = React.useMemo(
    () => showUpdates ? activity : activity.filter(item => item.kind === 'comment' || item.kind === 'file'),
    [activity, showUpdates],
  );

  // Group consecutive same-author items to save visual space
  const groups = React.useMemo(() => buildGroups(visibleActivity, gitUserName), [visibleActivity, gitUserName]);

  // Scroll to top when activity first loads (newest-first order)
  React.useEffect(() => {
    const justFinishedLoading = prevLoadingRef.current && !loading;
    prevLoadingRef.current = loading;
    if (!listRef.current) return;
    if (justFinishedLoading) {
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = 0;
      });
    }
  }, [loading]);

  // When editing starts, focus the textarea and scroll it into view
  React.useEffect(() => {
    if (editingId && editTextareaRef.current) {
      editTextareaRef.current.focus();
      editTextareaRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [editingId]);

  if (loading) {
    return <p style={{ color: 'var(--p-text-g)', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>Loading…</p>;
  }
  if (error) {
    return <p style={{ color: 'var(--p-red-500)', fontSize: 12, textAlign: 'center', padding: '8px 0' }}>Failed to load.</p>;
  }
  if (activity.length === 0) {
    return <p style={{ color: 'var(--p-text-g)', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>No activity yet.</p>;
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Activity header — eye icon toggle for system updates, only shown when updates exist */}
      {updateCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '4px 0 4px', flexShrink: 0, borderBottom: '1px solid var(--p-border)', marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--p-text-g)', flex: 1, letterSpacing: '0.04em' }}>
            {!showUpdates ? `${updateCount} system event${updateCount !== 1 ? 's' : ''} hidden` : ''}
          </span>
          <button
            id="dp-toggle-updates"
            onClick={() => setShowUpdates(v => {
              const next = !v;
              try { localStorage.setItem('vibeflow-show-updates', String(next)); } catch {}
              return next;
            })}
            style={{
              all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'center', width: 22, height: 22, borderRadius: 5,
              color: showUpdates ? 'var(--p-text-m)' : 'var(--p-text-g)',
              transition: 'color .12s, background .12s',
            }}
            title={showUpdates ? 'Hide system events' : `Show ${updateCount} system event${updateCount !== 1 ? 's' : ''}`}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--p-text)'; e.currentTarget.style.background = 'var(--p-hover)'; }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = showUpdates ? 'var(--p-text-m)' : 'var(--p-text-g)';
              e.currentTarget.style.background = 'transparent';
            }}
          >
            {showUpdates
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            }
          </button>
        </div>
      )}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0 }}>
      {groups.map((group, gIdx) => {
        // Only "group" (show header + indent) when 2+ consecutive items from same author
        const isGrouped = group.author !== null && group.items.length > 1;
        // Show group header only for multi-item groups; single items render their own inline header
        const showGroupHeader = isGrouped;
        const isAgent = group.author === '🤖 Agent';

        return (
          <div key={`group-${gIdx}`} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/* Group header — shown when there is an identified author */}
            {showGroupHeader && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0 2px', marginTop: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: isAgent ? 'var(--p-purple)' : 'var(--p-blue-300)', flexShrink: 0 }}>
                  {group.author}
                </span>
                <span style={{ fontSize: 10, color: 'var(--p-text-g)', flexShrink: 0 }}>
                  {`${formatDate(group.oldestSortKey)} – ${formatDate(group.newestSortKey)}`}
                </span>
                <span style={{ fontSize: 10, color: 'var(--p-border-t)', flexShrink: 0, marginLeft: 2 }}>
                  ({group.items.length} activities)
                </span>
              </div>
            )}

            {/* Items in the group — indented when grouped */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: isGrouped ? 4 : 8, paddingLeft: isGrouped ? 8 : 0, borderLeft: isGrouped ? '1.5px solid var(--p-border)' : 'none', marginLeft: isGrouped ? 4 : 0 }}>
              {group.items.map((item, iIdx) => renderActivityItem(item, iIdx, gIdx, isGrouped, gitUserName, editingId, editText, editTextareaRef, setEditingId, setEditText, onEdit, setConfirmDelete, onDeleteFile ? setConfirmDeleteFile : null, onFilePreview))}
            </div>
          </div>
        );
      })}
      </div>

      <ConfirmModal
        open={confirmDelete !== null}
        message="Delete this comment? This action cannot be undone."
        onConfirm={() => {
          if (confirmDelete) void onDelete(confirmDelete);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
      {onDeleteFile && (
        <ConfirmModal
          open={confirmDeleteFile !== null}
          message={confirmDeleteFile ? `Delete "${confirmDeleteFile.name}"? This action cannot be undone.` : ''}
          onConfirm={() => {
            if (confirmDeleteFile) void onDeleteFile(confirmDeleteFile);
            setConfirmDeleteFile(null);
          }}
          onCancel={() => setConfirmDeleteFile(null)}
        />
      )}
    </div>
  );
}

function renderActivityItem(
  item: ActivityItem,
  iIdx: number,
  gIdx: number,
  isGrouped: boolean,
  gitUserName: string,
  editingId: string | null,
  editText: string,
  editTextareaRef: React.RefObject<HTMLTextAreaElement>,
  setEditingId: (id: string | null) => void,
  setEditText: (t: string) => void,
  onEdit: (comment: Comment, newText: string) => Promise<void>,
  onRequestDelete: (comment: Comment) => void,
  onRequestDeleteFile: ((f: FileEntry) => void) | null,
  onFilePreview?: (name: string, url: string) => void,
): React.ReactNode {
  if (item.kind === 'lifecycle') {
    return (
      <div key={`lifecycle-${item.sortKey}-${gIdx}-${iIdx}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '2px 0' }}>
        <span style={{ fontSize: 11, color: 'var(--p-purple)', fontWeight: 600, flexShrink: 0, minWidth: 18, paddingTop: 1 }}>{item.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--p-text-m)', fontStyle: 'italic' }}>{item.label}</span>
            {!isGrouped && (
              <span style={{ fontSize: 10, color: 'var(--p-text-g)', marginLeft: 'auto', flexShrink: 0 }}>{formatDate(item.sortKey)}</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === 'change') {
    const trimLen = 28;
    const fromTrimmed = item.from.length > trimLen ? item.from.slice(0, trimLen) + '…' : item.from;
    const toTrimmed = item.to.length > trimLen ? item.to.slice(0, trimLen) + '…' : item.to;
    const needsTooltip = item.from.length > trimLen || item.to.length > trimLen;
    return (
      <div key={`change-${item.sortKey}-${gIdx}-${iIdx}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '2px 0' }}>
        <span style={{ fontSize: 11, color: 'var(--p-blue)', fontWeight: 600, flexShrink: 0, minWidth: 18, paddingTop: 1 }}>✎</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {!isGrouped && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--p-blue-300)' }}>👤 {item.actor}</span>}
            {!isGrouped && <SourceBadge source={item.source} />}
            <span style={{ fontSize: 11, color: 'var(--p-text-m)' }}>
              changed <strong style={{ color: 'var(--p-text)' }}>{item.field}</strong>
            </span>
            {!isGrouped && (
              <span style={{ fontSize: 10, color: 'var(--p-text-g)', marginLeft: 'auto', flexShrink: 0 }}>{formatDate(item.sortKey)}</span>
            )}
          </div>
          <div
            title={needsTooltip ? `${item.from} → ${item.to}` : undefined}
            style={{ marginTop: 2, fontSize: 11, color: 'var(--p-text-g)', display: 'flex', alignItems: 'center', gap: 4, cursor: needsTooltip ? 'help' : 'default' }}
          >
            <span style={{ color: 'var(--p-red)', background: 'rgba(239,68,68,0.1)', borderRadius: 4, padding: '1px 5px', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fromTrimmed}</span>
            <span style={{ color: 'var(--p-text-g)' }}>→</span>
            <span style={{ color: 'var(--p-green)', background: 'rgba(34,197,94,0.1)', borderRadius: 4, padding: '1px 5px', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{toTrimmed}</span>
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === 'file') {
    const { file, url } = item;
    return (
      <FileItem
        key={`file-${file.name}-${gIdx}-${iIdx}`}
        file={file}
        url={url}
        variant="compact"
        onPreview={onFilePreview ? (f, u) => onFilePreview(f.name, u) : undefined}
        onDelete={onRequestDeleteFile ? (f) => { onRequestDeleteFile(f); return Promise.resolve(); } : undefined}
      />
    );
  }

  const c = item.comment;
  const isAgent = c.author === 'agent';
  const isSystem = c.type === 'system';
  const isDeleted = c.deleted === true;
  // isOwnComment is undefined in CLI/local mode (no server context) — allow edit in that case for backward compat.
  // When explicitly false (web app, different author), hide edit/delete controls.
  const canEdit = !!c.id && !isAgent && !isSystem && !isDeleted && c.isOwnComment !== false;
  const isEditing = editingId === c.id;

  if (isSystem) {
    return (
      <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 11, color: 'var(--p-text-g)', fontStyle: 'italic' }}>
        <span style={{ opacity: 0.6 }}>⬡</span>
        <span>{c.text}</span>
        {!isGrouped && <span style={{ marginLeft: 'auto', flexShrink: 0, opacity: 0.6 }}>{formatDate(c.createdAt)}</span>}
      </div>
    );
  }

  return (
    <div key={c.id} className="flex flex-col gap-1 group/comment" style={{ paddingTop: isGrouped ? 2 : 4 }}>
      {!isGrouped && (
        <div className="flex items-center justify-between gap-1.5 text-xs mb-0.5">
          <div className="flex items-center gap-1.5">
            <span style={{ color: isDeleted ? 'var(--p-text-g)' : (isAgent ? 'var(--p-purple)' : 'var(--p-blue-300)') }}>
              {isAgent ? '🤖 Agent' : `👤 ${c.authorName ?? gitUserName}`}
            </span>
            <SourceBadge source={c.source} />
            <span style={{ color: 'var(--p-text-g)' }}>
              {formatDate(c.createdAt)}{!isDeleted && c.updatedAt ? ' · edited' : ''}{isDeleted ? ' · deleted' : ''}
            </span>
          </div>
          {canEdit && (
            <div className="flex items-center gap-1 opacity-0 group-hover/comment:opacity-100 transition-opacity">
              <button onClick={() => { setEditingId(c.id); setEditText(c.text); }} className="p-1 rounded hover:bg-slate-700 transition-colors" title="Edit">
                <span style={{ fontSize: 11, color: 'var(--p-text-m)' }}>✎</span>
              </button>
              <button onClick={() => onRequestDelete(c)} className="p-1 rounded hover:bg-red-900/40 transition-colors" title="Delete">
                <span style={{ fontSize: 11, color: 'var(--p-text-m)' }}>✕</span>
              </button>
            </div>
          )}
        </div>
      )}
      {isGrouped && (
        <div className="flex items-center justify-between gap-1.5" style={{ marginBottom: 2 }}>
          <span style={{ fontSize: 10, color: 'var(--p-text-g)' }}>
            {formatDate(c.createdAt)}{!isDeleted && c.updatedAt ? ' · edited' : ''}{isDeleted ? ' · deleted' : ''}
          </span>
          {canEdit && (
            <div className="flex items-center gap-1 opacity-0 group-hover/comment:opacity-100 transition-opacity">
              <button onClick={() => { setEditingId(c.id); setEditText(c.text); }} className="p-1 rounded hover:bg-slate-700 transition-colors" title="Edit">
                <span style={{ fontSize: 11, color: 'var(--p-text-m)' }}>✎</span>
              </button>
              <button onClick={() => onRequestDelete(c)} className="p-1 rounded hover:bg-red-900/40 transition-colors" title="Delete">
                <span style={{ fontSize: 11, color: 'var(--p-text-m)' }}>✕</span>
              </button>
            </div>
          )}
        </div>
      )}
      {isEditing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <AutoExpandTextarea
            ref={editTextareaRef}
            value={editText}
            onChange={setEditText}
            baseRows={4}
            maxRows={12}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void onEdit(c, editText).then(() => setEditingId(null)); } }}
            style={{ width: '100%', background: 'var(--p-input)', border: '1px solid var(--p-border-s)', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: 'var(--p-text)', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditingId(null)} style={{ padding: '4px 10px', background: 'var(--p-surface)', border: 'none', borderRadius: 5, fontSize: 11, color: 'var(--p-text-sub)', cursor: 'pointer' }}>Cancel</button>
            <button onClick={async () => { await onEdit(c, editText); setEditingId(null); }} style={{ padding: '4px 10px', background: 'var(--p-blue)', border: 'none', borderRadius: 5, fontSize: 11, color: 'var(--p-white)', cursor: 'pointer' }}>Save</button>
          </div>
        </div>
      ) : isDeleted ? (
        <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--p-text-g)', fontStyle: 'italic', background: 'var(--p-input)', border: '1px dashed var(--p-border)', borderRadius: 8 }}>
          Comment deleted
        </div>
      ) : (
        <MarkdownPreview
          markdown={c.text}
          style={{ background: 'var(--p-input)', border: '1px solid var(--p-border)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--p-text-sub)', lineHeight: 1.6 }}
        />
      )}
    </div>
  );
}
