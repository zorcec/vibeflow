/**
 * TaskDetailsTab — the "Details" pane inside the DetailPanel.
 *
 * Handles rendering of description editor, screenshot preview,
 * priority selector, and task metadata tiles.
 * All state lives in DetailPanel; this component is purely presentational.
 */
import React from 'react';
import type { Task, Priority, FileEntry } from '../../types';
import { MarkdownEditableField } from './MarkdownEditableField';
import { formatDate } from '../../utils';
import { ConfirmModal } from '../ConfirmModal';
import { TagInput } from './TagInput';

interface Props {
  task: Task | null;
  description: string;
  setDescription: (v: string) => void;
  showDescPreview: boolean;
  setShowDescPreview: (v: boolean) => void;
  priority: Priority | '';
  setPriority: (v: Priority | '') => void;
  onDescriptionBlur?: () => void;
  onDescriptionDiscard?: () => void;
  originalDescription?: string;
  onPriorityChange?: (v: Priority | '') => void;
  githubUrl?: string | null;
  onFilePreview: (name: string, url: string) => void;
  onDeleteScreenshot: (name: string) => void;
  onPatch: (taskId: string, patch: Partial<Task>) => void;
  /** Global tag pool for autocomplete. */
  allTags?: string[];
  /** Tags override for the add-new-task form (bypasses task?.tags). */
  overrideTags?: string[];
  /** Called when tags change in the add-new-task form. */
  onTagsChange?: (tags: string[]) => void;
  /** Live files list from the panel; overrides task.files for screenshot display. */
  liveFiles?: FileEntry[];
}

export function TaskDetailsTab({
  task, description, setDescription, showDescPreview, setShowDescPreview,
  priority, setPriority, onDescriptionBlur, onDescriptionDiscard, originalDescription, onPriorityChange, githubUrl, onFilePreview, onPatch,
  onDeleteScreenshot, liveFiles, allTags = [], overrideTags, onTagsChange,
}: Props) {
  const taskFiles = task?.files ?? [];
  const fileList: Array<{ name: string; linkedPath?: string; addedAt?: string; url?: string }> = liveFiles
    ? liveFiles.map(f => ({ name: f.name, linkedPath: f.linkedPath, addedAt: f.createdAt, url: f.url }))
    : taskFiles;
  const firstImage = fileList?.find((f) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(f.name));
  const screenshotUrl = task && firstImage
    ? (firstImage.url || `/api/tasks/${task.id}/files/${encodeURIComponent(firstImage.name)}`)
    : null;
  const descRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [confirmDeleteScreenshot, setConfirmDeleteScreenshot] = React.useState<string | null>(null);

  const { userPart, consolePart } = splitConsoleLogs(description);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Description */}
      <div>
        <div className="dp-meta-label" style={{ marginBottom: 4 }}>Description</div>
        <MarkdownEditableField
          value={description}
          previewValue={consolePart ? userPart : undefined}
          onChange={setDescription}
          onBlur={onDescriptionBlur}
          showPreview={showDescPreview}
          setShowPreview={setShowDescPreview}
          previewId="dp-desc-preview"
          textareaId="dp-desc"
          placeholder="Description (markdown)…"
          previewMinHeight={80}
          previewMaxHeight={220}
          baseRows={6}
          maxRows={12}
          autoFocus
          textareaRef={descRef}
          afterTextarea={
            onDescriptionDiscard && originalDescription !== undefined && description !== originalDescription ? (
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); onDescriptionDiscard(); }}
                title="Discard changes and restore saved description"
                style={{
                  marginTop: 4, display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 11, color: 'var(--p-text-g)', background: 'none', border: '1px solid var(--p-border-t)',
                  borderRadius: 6, padding: '3px 8px', cursor: 'pointer', transition: 'color .12s, border-color .12s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--p-amber-300)'; e.currentTarget.style.borderColor = 'var(--p-amber-300)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--p-text-g)'; e.currentTarget.style.borderColor = 'var(--p-border-t)'; }}
              >
                ↩ Discard changes
              </button>
            ) : undefined
          }
        />
      </div>

      {/* Console Logs — dedicated section shown for Bug tasks with captured errors */}
      {consolePart && (
        <ConsoleLogsSection logs={consolePart} />
      )}

      {task && firstImage && screenshotUrl && (
        <div>
          <div className="dp-meta-label">Screenshot</div>
          <div
            id="dp-screenshot-preview"
            style={{ border: '1px solid color-mix(in srgb, var(--p-border-t) 70%, transparent)', borderRadius: 10, overflow: 'hidden', background: 'var(--p-card)' }}
          >
            <button
              onClick={() => onFilePreview(firstImage.name, screenshotUrl)}
              style={{ width: '100%', height: 112, border: 'none', padding: 0, background: 'linear-gradient(135deg, var(--p-border), var(--p-bg))', cursor: 'pointer', display: 'block', overflow: 'hidden' }}
              title="Preview screenshot"
            >
              <img src={screenshotUrl} alt="Task screenshot" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: '1px solid var(--p-border)', background: 'var(--p-surface)' }}>
                <span style={{ fontSize: 10, color: 'var(--p-text-f)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {firstImage.addedAt ? `Captured ${formatDate(firstImage.addedAt)}` : 'Screenshot attached'}
              </span>
              <button
                onClick={() => onFilePreview(firstImage.name, screenshotUrl)}
                style={{ fontSize: 10, color: 'var(--p-text-m)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                title="Preview screenshot"
              >
                Preview
              </button>
              <button
                onClick={() => setConfirmDeleteScreenshot(firstImage.name)}
                style={{ fontSize: 10, color: 'var(--p-red)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                title="Remove screenshot"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tags */}
      <div>
        <div className="dp-meta-label">Tags</div>
        <TagInput
          tags={overrideTags ?? task?.tags ?? []}
          allTags={allTags}
          disabled={!task && !onTagsChange}
          onChange={(newTags) => {
            if (onTagsChange) {
              onTagsChange(newTags);
            } else if (task) {
              onPatch(task.id, { tags: newTags });
            }
          }}
        />
      </div>

      {/* Priority */}
      <div>
        <div className="dp-meta-label">Priority</div>
        <select
          id="dp-priority"
          className="dp-input"
          value={priority}
          onChange={(e) => {
            const v = e.target.value as Priority | '';
            setPriority(v);
            onPriorityChange?.(v);
          }}
          style={{ padding: '5px 8px', fontSize: 12, cursor: 'pointer', width: 'auto' }}
        >
          <option value="">—</option>
          <option value="Critical">Critical</option>
          <option value="High">High</option>
          <option value="Medium">Medium</option>
          <option value="Low">Low</option>
        </select>
      </div>

      {/* Metadata tiles (read-only summary stays at the bottom) */}
      {task && (
        <div id="dp-metadata" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <MetaTile label="Created" id="dp-created">{task.createdAt ? formatDate(task.createdAt) : '—'}</MetaTile>
          <MetaTile label="ID" id="dp-id"><span style={{ fontFamily: 'monospace' }}>{task.id}</span></MetaTile>
          <MetaTile label="Author" id="dp-author">{task.authorName ?? task.author ?? '—'}</MetaTile>
          {task.agent && <MetaTile label="Agent" id="dp-agent"><span style={{ color: '#a78bfa' }}>{task.agent}</span></MetaTile>}
          {(task.commit || task.commits?.length) && <CommitTile task={task} githubUrl={githubUrl} />}
          {task.annotatedElementText && (
            <div id="dp-annotated-text" style={{ gridColumn: '1 / -1', background: 'var(--p-card)', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontSize: 9, color: 'var(--p-border-t)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Annotated element text</div>
              <div style={{ fontSize: 11, color: 'var(--p-text-f)', fontStyle: 'italic', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{task.annotatedElementText}</div>
            </div>
          )}
        </div>
      )}
      <ConfirmModal
        open={confirmDeleteScreenshot !== null}
        message="Remove this screenshot? This action cannot be undone."
        confirmLabel="Remove"
        onConfirm={() => {
          if (confirmDeleteScreenshot) onDeleteScreenshot(confirmDeleteScreenshot);
          setConfirmDeleteScreenshot(null);
        }}
        onCancel={() => setConfirmDeleteScreenshot(null)}
      />
    </div>
  );
}

function MetaTile({ label, id, children }: { label: string; id?: string; children: React.ReactNode }) {
  return (
    <div id={id} style={{ background: 'var(--p-card)', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ fontSize: 9, color: 'var(--p-border-t)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--p-text-f)', borderBottom: '1px solid var(--p-border)', paddingBottom: 4, display: 'flex', alignItems: 'center', minHeight: 16 }}>{children}</div>
    </div>
  );
}

function CommitTile({ task, githubUrl }: { task: Task; githubUrl?: string | null }) {  const allCommits = task.commits?.length
    ? task.commits
    : [{ sha: task.commit!, message: task.title ?? '', timestamp: task.createdAt ?? '' }];
  const last = allCommits[allCommits.length - 1];
  const tooltipLines = allCommits
    .map((c: { sha: string; message: string; timestamp: string }) =>
      `${c.sha.slice(0, 8)}  ${c.timestamp ? new Date(c.timestamp).toLocaleString() : ''}  ${c.message.slice(0, 60)}`
    )
    .join('\n');
  return (
    <div
      id="dp-commit"
      style={{ background: 'var(--p-card)', borderRadius: 8, padding: '8px 10px', cursor: 'default' }}
      title={allCommits.length > 1 ? `All commits:\n${tooltipLines}` : `${last.sha}\n${last.message}`}
    >
      <div style={{ fontSize: 9, color: 'var(--p-border-t)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Commit{allCommits.length > 1 ? 's' : ''}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {githubUrl && task.commitPushed !== false ? (
          <a
            href={`${githubUrl}/commit/${last.sha}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 10, color: 'var(--p-blue-300)', fontFamily: 'monospace', textDecoration: 'none' }}
            title="Open diff on GitHub"
            onClick={(e) => e.stopPropagation()}
          >
            {last.sha.slice(0, 8)} ↗
          </a>
        ) : (
          <span
            style={{ fontSize: 10, color: 'var(--p-text-f)', fontFamily: 'monospace' }}
            title={task.commitPushed === false ? 'Commit not pushed to remote yet' : undefined}
          >
            {last.sha.slice(0, 8)}{task.commitPushed === false ? ' ⏳' : ''}
          </span>
        )}
        {allCommits.length > 1 && (
          <span style={{ fontSize: 9, color: 'var(--p-blue)', background: 'color-mix(in srgb, var(--p-blue) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--p-blue) 25%, transparent)', borderRadius: 10, padding: '0 5px', fontWeight: 600 }}>
            +{allCommits.length - 1}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Splits a task description into the user-written part and the auto-captured
 * console-log section appended by getRecordedLogs() when type=Bug.
 *
 * The separator injected by getRecordedLogs is "\n\n---\n**Console logs**".
 */
function splitConsoleLogs(description: string): { userPart: string; consolePart: string | null } {
  const SEPARATOR = '\n---\n**Console logs**';
  const idx = description.indexOf(SEPARATOR);
  if (idx === -1) return { userPart: description, consolePart: null };
  return {
    userPart: description.slice(0, idx).trim(),
    consolePart: description.slice(idx + 1).trim(), // skip the leading newline
  };
}

/** Renders the auto-captured console log section in a distinct, always-visible card. */
function ConsoleLogsSection({ logs }: { logs: string }) {
  const lines = logs
    // Remove the "---\n**Console logs** (N entries)" header line(s) for clean rendering
    .replace(/^---\s*\n/, '')
    .split('\n')
    .filter((l) => l.trim());

  return (
    <div id="dp-console-logs" style={{ borderRadius: 8, border: '1px solid color-mix(in srgb, var(--p-red) 30%, var(--p-border))', background: 'color-mix(in srgb, var(--p-red) 4%, var(--p-card))', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid color-mix(in srgb, var(--p-red) 20%, var(--p-border))', background: 'color-mix(in srgb, var(--p-red) 8%, var(--p-card))' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'color-mix(in srgb, var(--p-red) 80%, var(--p-text-sub))', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Console Logs</span>
        <span style={{ fontSize: 9, color: 'var(--p-text-g)', marginLeft: 'auto' }}>captured at submission</span>
      </div>
      <div style={{ padding: '6px 10px', maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {lines.map((line, i) => {
          const isError = line.includes('🔴');
          const isWarn = line.includes('🟡');
          const clean = line.replace(/^[-*]\s*/, '');
          return (
            <div
              key={i}
              style={{
                fontFamily: 'Menlo, monospace',
                fontSize: 10,
                lineHeight: 1.5,
                color: isError ? 'var(--p-red)' : isWarn ? 'var(--p-amber-300)' : 'var(--p-text-f)',
                wordBreak: 'break-all',
              }}
            >
              {clean}
            </div>
          );
        })}
        {lines.length === 0 && (
          <div style={{ fontSize: 10, color: 'var(--p-text-g)', fontStyle: 'italic' }}>No log entries captured.</div>
        )}
      </div>
    </div>
  );
}
