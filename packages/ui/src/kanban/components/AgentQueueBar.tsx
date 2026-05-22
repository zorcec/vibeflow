import React from 'react';
import { Bot, Square, ChevronUp, ChevronDown } from 'lucide-react';
import type { AgentRun } from '../types';

interface Props {
  runs: AgentRun[];
  onStop: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
}

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return '';
  const diff = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

export function AgentQueueBar({ runs, onStop, onOpenTask }: Props) {
  const [expanded, setExpanded] = React.useState(false);

  if (runs.length === 0) return null;

  const running = runs.find((r) => r.status === 'running');
  const queued = runs.filter((r) => r.status === 'queued');
  const done = runs.filter((r) => r.status === 'done' || r.status === 'failed');

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 35,
        borderTop: '1px solid var(--p-border)',
        background: 'var(--p-surface)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'max-height .2s ease',
      }}
    >
      {/* Collapsed bar */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 14px', minHeight: 40,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--p-text-m)', flexShrink: 0 }}>
          <Bot style={{ width: 12, height: 12, display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
          Agent Queue
        </span>

        {running && (
          <div
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '3px 8px', borderRadius: 5, fontSize: 10,
              background: 'var(--p-bg-2)', border: '1px solid var(--p-border)',
              color: 'var(--p-text)', cursor: 'pointer',
            }}
            onClick={() => onOpenTask(running.taskId)}
            title="Click to open task"
          >
            <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
            <span style={{ fontWeight: 500 }}>{running.taskTitle}</span>
            <span style={{ color: 'var(--p-text-g)' }}>{formatElapsed(running.startedAt)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onStop(running.taskId); }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--p-red)', padding: 0, display: 'flex', alignItems: 'center',
              }}
              title="Stop"
            >
              <Square style={{ width: 9, height: 9 }} />
            </button>
          </div>
        )}

        {queued.map((q) => (
          <div
            key={q.taskId}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '3px 8px', borderRadius: 5, fontSize: 10,
              background: 'var(--p-bg-2)', border: '1px solid var(--p-border)',
              color: 'var(--p-text-m)', opacity: 0.7, cursor: 'pointer',
            }}
            onClick={() => onOpenTask(q.taskId)}
            title="Click to open task"
          >
            <span style={{ color: 'var(--p-amber)' }}>⏳</span>
            <span>{q.taskTitle}</span>
          </div>
        ))}

        <div style={{ flex: 1 }} />

        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            background: 'none', border: '1px solid var(--p-border)', borderRadius: 5,
            padding: '3px 8px', cursor: 'pointer', color: 'var(--p-text-g)',
            fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          {expanded ? <ChevronDown style={{ width: 10, height: 10 }} /> : <ChevronUp style={{ width: 10, height: 10 }} />}
          {expanded ? 'Collapse' : 'Details'}
        </button>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--p-border)',
            padding: '10px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          {runs.map((run) => (
            <div
              key={run.taskId}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 10px', borderRadius: 6,
                border: run.status === 'running' ? '1px solid color-mix(in srgb, var(--p-blue) 30%, transparent)' : '1px solid var(--p-border)',
                background: run.status === 'running' ? 'color-mix(in srgb, var(--p-blue) 6%, transparent)' : 'var(--p-bg-2)',
                cursor: 'pointer',
              }}
              onClick={() => onOpenTask(run.taskId)}
            >
              {run.status === 'running' && <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />}
              {run.status === 'queued' && <span style={{ color: 'var(--p-amber)', fontSize: 10 }}>⏳</span>}
              {run.status === 'done' && <span style={{ color: 'var(--p-green)', fontSize: 10 }}>✓</span>}
              {run.status === 'failed' && <span style={{ color: 'var(--p-red)', fontSize: 10 }}>✗</span>}
              <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--p-text)', flex: 1 }}>{run.taskTitle}</span>
              <span style={{ fontSize: 10, color: 'var(--p-text-g)', fontFamily: 'monospace' }}>{run.model}</span>
              {run.status === 'running' && (
                <span style={{ fontSize: 10, color: 'var(--p-text-g)' }}>{formatElapsed(run.startedAt)}</span>
              )}
              {run.status === 'running' && (
                <button
                  onClick={(e) => { e.stopPropagation(); onStop(run.taskId); }}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--p-red)', padding: 0, display: 'flex', alignItems: 'center',
                  }}
                  title="Stop"
                >
                  <Square style={{ width: 9, height: 9 }} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
