import React from 'react';
import { MessageCircle, Paperclip, Flag } from 'lucide-react';
import type { Task, TaskStatus, LiveActivity } from '../types';
import { LiveActivityBadge } from './TaskCard';
import { TASK_TYPE_ICONS } from '../../task-types';

const STATUS_COLORS: Record<TaskStatus, { text: string; bg: string; border: string }> = {
  backlog:      { text: 'var(--p-text-m)', bg: 'color-mix(in srgb, var(--p-text-g) 14%, transparent)', border: 'color-mix(in srgb, var(--p-text-g) 30%, transparent)' },
  todo:         { text: 'var(--p-amber-300)', bg: 'color-mix(in srgb, var(--p-amber) 14%, transparent)', border: 'color-mix(in srgb, var(--p-amber) 30%, transparent)' },
  'in-progress':{ text: 'var(--p-blue-200)', bg: 'color-mix(in srgb, var(--p-blue) 14%, transparent)', border: 'color-mix(in srgb, var(--p-blue) 30%, transparent)' },
  review:       { text: 'var(--p-purple-300)', bg: 'color-mix(in srgb, var(--p-purple) 14%, transparent)', border: 'color-mix(in srgb, var(--p-purple) 30%, transparent)' },
  done:         { text: 'var(--p-green-300)', bg: 'color-mix(in srgb, var(--p-green) 12%, transparent)', border: 'color-mix(in srgb, var(--p-green) 30%, transparent)' },
};

const TYPE_ICONS: Record<string, string> = TASK_TYPE_ICONS;

const PRIORITY_COLORS: Record<string, string> = {
  Critical: 'var(--p-red)', High: 'var(--p-amber-300)', Medium: 'var(--p-text-m)', Low: 'var(--p-text-f)',
};

const STATUS_ORDER: TaskStatus[] = ['in-progress', 'review', 'todo', 'backlog', 'done'];

interface Props {
  tasks: Task[];
  searchQuery: string;
  isLoading?: boolean;
  liveActivities?: Map<string, LiveActivity>;
  onOpenPanel: (task: Task, tab?: 'details' | 'comments' | 'files' | 'agent') => void;
  onAddTask: (status: TaskStatus) => void;
  onDrop: (taskId: string, newStatus: TaskStatus) => void;
  /** When false, agent-related UI is hidden. */
  experimentalAgents?: boolean;
}

function SkeletonListRow() {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '18px 1fr auto auto', alignItems: 'center', gap: 10,
      padding: '6px 10px', borderRadius: 8, border: '1px solid var(--p-border-t)',
      background: 'var(--p-bg-2)', animation: 'skeleton-pulse 1.5s ease-in-out infinite',
    }}>
      <div style={{ width: 14, height: 14, borderRadius: 3, background: 'var(--p-border-s)' }} />
      <div style={{ height: 12, borderRadius: 4, background: 'var(--p-border-s)', width: '60%' }} />
      <div style={{ height: 18, borderRadius: 10, background: 'var(--p-border-s)', width: 44 }} />
      <div style={{ height: 18, borderRadius: 10, background: 'var(--p-border-s)', width: 36 }} />
    </div>
  );
}

export function KanbanListView({ tasks, searchQuery, isLoading, liveActivities, onOpenPanel, onAddTask, onDrop, experimentalAgents }: Props) {
  const [dragTaskId, setDragTaskId] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState<TaskStatus | null>(null);
  const [dragOverRowId, setDragOverRowId] = React.useState<string | null>(null);
  const [collapsed, setCollapsed] = React.useState<Record<TaskStatus, boolean>>({
    backlog: false,
    todo: false,
    'in-progress': false,
    review: false,
    done: false,
  });
  const filtered = searchQuery
    ? tasks.filter(t =>
        (t.title ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (t.description ?? '').toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : tasks;

  const grouped = React.useMemo(() => {
    const map = new Map<TaskStatus, Task[]>();
    for (const s of STATUS_ORDER) map.set(s, []);
    for (const t of filtered) {
      const bucket = map.get(t.status) ?? [];
      bucket.push(t);
    }
    return map;
  }, [filtered]);

  return (
    <div
      id="kanban-list-view"
      style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', minHeight: 0 }}
    >
      {isLoading ? (
        STATUS_ORDER.slice(0, 3).map(status => {
          const sc = STATUS_COLORS[status];
          return (
            <div key={status} style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ width: 18, height: 18, borderRadius: 5, background: 'var(--p-border-s)', animation: 'skeleton-pulse 1.5s ease-in-out infinite' }} />
                <div style={{ height: 18, borderRadius: 6, background: sc.bg, border: `1px solid ${sc.border}`, width: 72, animation: 'skeleton-pulse 1.5s ease-in-out infinite' }} />
                <div style={{ height: 14, borderRadius: 4, background: 'var(--p-border-s)', width: 16, animation: 'skeleton-pulse 1.5s ease-in-out infinite' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {Array.from({ length: 3 }).map((_, i) => <SkeletonListRow key={i} />)}
              </div>
            </div>
          );
        })
      ) : (
        STATUS_ORDER.map(status => {
        const group = grouped.get(status) ?? [];
        if (group.length === 0) return null;
        const sc = STATUS_COLORS[status];
        return (
          <div key={status} style={{ marginBottom: 24 }}>
            {/* Group header */}
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
                padding: '4px 6px', borderRadius: 6, transition: 'background .1s',
                background: dragOver === status ? sc.bg : 'transparent',
                outline: dragOver === status ? `1px dashed ${sc.border}` : undefined,
              }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(status); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                setDragOverRowId(null);
                if (dragTaskId) onDrop(dragTaskId, status);
                setDragTaskId(null);
              }}
            >
              <button
                type="button"
                title={collapsed[status] ? 'Expand' : 'Collapse'}
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsed((prev) => ({ ...prev, [status]: !prev[status] }));
                }}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  border: '1px solid var(--p-border-t)',
                  background: 'var(--p-surface)',
                  color: 'var(--p-text-m)',
                  fontSize: 10,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {collapsed[status] ? '+' : '−'}
              </button>
              <span
                style={{
                  fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
                  padding: '2px 8px', borderRadius: 6, background: sc.bg, border: `1px solid ${sc.border}`,
                  color: sc.text,
                }}
              >{status}</span>
              <span style={{ fontSize: 11, color: 'var(--p-text-g)' }}>{group.length}</span>
              <button
                type="button"
                title={`Add task to ${status}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onAddTask(status);
                }}
                style={{
                  marginLeft: 'auto',
                  width: 22,
                  height: 22,
                  borderRadius: 7,
                  border: `1px solid ${sc.border}`,
                  background: sc.bg,
                  color: sc.text,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                +
              </button>
            </div>

            {/* Task rows */}
            <div style={{ display: collapsed[status] ? 'none' : 'flex', flexDirection: 'column', gap: 2 }}>
              {group.map(task => (
                <ListRow
                  key={task.id}
                  task={task}
                  liveActivity={liveActivities?.get(task.id)}
                  onOpen={onOpenPanel}
                  onDragStart={(taskId) => setDragTaskId(taskId)}
                  dragOver={dragOverRowId === task.id}
                  onDragOver={() => setDragOverRowId(task.id)}
                  onDragLeave={() => setDragOverRowId((prev) => (prev === task.id ? null : prev))}
                  onDropToStatus={() => {
                    if (dragTaskId) onDrop(dragTaskId, task.status);
                    setDragTaskId(null);
                    setDragOverRowId(null);
                  }}
                  experimentalAgents={experimentalAgents}
                />
              ))}
            </div>
          </div>
        );
      })
      )}

      {!isLoading && filtered.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--p-text-g)', fontSize: 13, marginTop: 60 }}>
          No tasks found
        </div>
      )}
    </div>
  );
}

interface RowProps {
  task: Task;
  liveActivity?: LiveActivity;
  onOpen: (task: Task, tab?: 'details' | 'comments' | 'files') => void;
  onDragStart: (taskId: string) => void;
  dragOver: boolean;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDropToStatus: () => void;
  experimentalAgents?: boolean;
}

function ListRow({ task, liveActivity, onOpen, onDragStart, dragOver, onDragOver, onDragLeave, onDropToStatus, experimentalAgents }: RowProps) {
  const [hovered, setHovered] = React.useState(false);
  const typeIcon = TYPE_ICONS[task.type ?? 'Task'] ?? '☑';
  const commentCount = task.commentCount ?? 0;
  const fileCount = task.fileCount ?? 0;

  return (
    <div
      data-task-id={task.id}
      data-proto-id="list-row"
      draggable
      style={{
        display: 'grid',
        gridTemplateColumns: '18px 1fr auto auto auto',
        alignItems: 'center',
        gap: 10,
        padding: '6px 10px',
        borderRadius: 8,
        background: dragOver ? 'color-mix(in srgb, var(--p-blue) 10%, transparent)' : (hovered ? 'var(--p-hover)' : 'transparent'),
        border: `1px solid ${dragOver ? 'color-mix(in srgb, var(--p-blue) 40%, transparent)' : (hovered ? 'var(--p-border)' : 'transparent')}`,
        cursor: 'grab',
        transition: 'background .1s,border-color .1s',
        userSelect: 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onOpen(task)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(task.id);
        (e.currentTarget as HTMLElement).style.opacity = '0.4';
      }}
      onDragEnd={(e) => {
        (e.currentTarget as HTMLElement).style.opacity = '1';
      }}
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        onDropToStatus();
      }}
    >
      {/* Type icon */}
      <span style={{ fontSize: 12, textAlign: 'center', flexShrink: 0 }}>{typeIcon}</span>

      {/* Title + description */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--p-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {task.title}
          </span>
          {task.priority && PRIORITY_COLORS[task.priority] && (
            <Flag className="w-2.5 h-2.5 flex-shrink-0" style={{ color: PRIORITY_COLORS[task.priority] }} />
          )}
          {task.component && (
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, background: 'color-mix(in srgb, var(--p-purple) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--p-purple) 30%, transparent)', color: 'var(--p-purple-300)', flexShrink: 0, fontFamily: 'monospace' }}>
              {task.component}
            </span>
          )}
        </div>
        {task.description && (
          <div style={{ fontSize: 11, color: 'var(--p-text-g)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1, maxWidth: '100%' }}>
            {task.description.replace(/\s+/g, ' ').trim()}
          </div>
        )}
      </div>

      {/* Comment count */}
      <button
        title={commentCount > 0 ? `${commentCount} comment(s)` : 'Add comment'}
        style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: commentCount > 0 ? 'var(--p-text-m)' : 'var(--p-border-t)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}
        onClick={(e) => { e.stopPropagation(); onOpen(task, 'comments'); }}
      >
        <MessageCircle className="w-3 h-3" />
        {commentCount > 0 && <span>{commentCount}</span>}
      </button>

      {/* File count — only rendered when files exist; takes no space otherwise */}
      {fileCount > 0 && (
        <button
          title={`${fileCount} file(s)`}
          style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--p-blue-300)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}
          onClick={(e) => { e.stopPropagation(); onOpen(task, 'files'); }}
        >
          <Paperclip className="w-3 h-3" />
          <span>{fileCount}</span>
        </button>
      )}

      {/* Live activity badge */}
      {liveActivity && <LiveActivityBadge activity={liveActivity} />}

    </div>
  );
}
