import React from 'react';
import { X, Square, Bot, Clock } from 'lucide-react';
import type { AgentRun } from '../types';

interface Props {
  open: boolean;
  runs: AgentRun[];
  onStop: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
}

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return '';
  const diff = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

const statusColors: Record<string, string> = {
  running: 'var(--p-blue)',
  queued: 'var(--p-amber)',
  done: 'var(--p-green)',
  failed: 'var(--p-red)',
};

const statusLabels: Record<string, string> = {
  running: 'Running',
  queued: 'Queued',
  done: 'Completed',
  failed: 'Failed',
};

export function AgentQueuePanel({ open, runs, onStop, onOpenTask, onClose }: Props) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [elapsedMap, setElapsedMap] = React.useState<Record<string, string>>({});

  // Update elapsed times for running tasks
  React.useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => {
      const next: Record<string, string> = {};
      for (const run of runs) {
        if (run.status === 'running' && run.startedAt) {
          next[run.taskId] = formatElapsed(run.startedAt);
        }
      }
      setElapsedMap(next);
    }, 1000);
    return () => clearInterval(interval);
  }, [open, runs]);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose]);

  if (!open) return null;

  const activeRuns = runs.filter(r => r.status === 'running' || r.status === 'queued');
  const completedRuns = runs.filter(r => r.status === 'done' || r.status === 'failed');

  return (
    <div
      ref={panelRef}
      id="agent-queue-panel"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(420px, 90vw)',
        background: 'var(--p-surface)',
        borderLeft: '1px solid var(--p-border)',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: 'var(--p-shadow-lg)',
      }}
    >
      {/* Header */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--p-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Bot style={{ width: 16, height: 16, color: 'var(--p-purple-300)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--p-text)', flex: 1 }}>Agent Queue</span>
        <span style={{ fontSize: 11, color: 'var(--p-text-g)', background: 'var(--p-bg-2)', padding: '2px 8px', borderRadius: 10 }}>
          {activeRuns.length} active · {completedRuns.length} completed
        </span>
        <button
          id="agent-queue-close"
          onClick={onClose}
          style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--p-text-g)', cursor: 'pointer' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--p-surface)'; e.currentTarget.style.color = 'var(--p-text-m)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--p-text-g)'; }}
        >
          <X style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {/* Runs list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {runs.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--p-text-g)' }}>
            No agent runs yet. Open a task and click the Agent tab to start.
          </div>
        )}

        {runs.map((run) => (
          <div
            key={run.taskId}
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${run.status === 'running' ? 'color-mix(in srgb, var(--p-blue) 30%, transparent)' : 'var(--p-border)'}`,
              background: run.status === 'running' ? 'color-mix(in srgb, var(--p-blue) 6%, transparent)' : 'var(--p-bg-2)',
              cursor: 'pointer',
              transition: 'background .12s',
            }}
            onClick={() => onOpenTask(run.taskId)}
            onMouseEnter={(e) => { e.currentTarget.style.background = run.status === 'running' ? 'color-mix(in srgb, var(--p-blue) 10%, transparent)' : 'var(--p-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = run.status === 'running' ? 'color-mix(in srgb, var(--p-blue) 6%, transparent)' : 'var(--p-bg-2)'; }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              {run.status === 'running' && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />}
              {run.status === 'queued' && <span style={{ color: 'var(--p-amber)', fontSize: 12 }}>⏳</span>}
              {run.status === 'done' && <span style={{ color: 'var(--p-green)', fontSize: 12 }}>✓</span>}
              {run.status === 'failed' && <span style={{ color: 'var(--p-red)', fontSize: 12 }}>✗</span>}
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--p-text)', flex: 1 }}>{run.taskTitle}</span>
              <span style={{
                fontSize: 10,
                fontWeight: 500,
                color: statusColors[run.status] ?? 'var(--p-text-g)',
                padding: '1px 6px',
                borderRadius: 4,
                background: `${statusColors[run.status] ?? 'var(--p-text-g)'}15`,
              }}>
                {statusLabels[run.status] ?? run.status}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 10, color: 'var(--p-text-g)' }}>
              {run.model && <span>Model: {run.model}</span>}
              {run.status === 'running' && elapsedMap[run.taskId] && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Clock style={{ width: 9, height: 9 }} />
                  {elapsedMap[run.taskId]}
                </span>
              )}
            </div>
            {run.logs.length > 0 && (
              <div style={{
                marginTop: 8,
                padding: '6px 8px',
                background: '#0a0c10',
                borderRadius: 6,
                fontFamily: "'SF Mono', 'Fira Code', monospace",
                fontSize: 9,
                lineHeight: 1.5,
                color: '#a3e635',
                maxHeight: 80,
                overflowY: 'auto',
              }}>
                {run.logs.slice(-3).map((line, i) => (
                  <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {line.startsWith('$') ? <span style={{ color: 'var(--p-text-g)' }}>{line}</span>
                      : line.startsWith('✓') ? <span style={{ color: 'var(--p-green)' }}>{line}</span>
                      : line.startsWith('▶') || line.startsWith('→') ? <span style={{ color: 'var(--p-blue-300)' }}>{line}</span>
                      : line.startsWith('✗') || line.startsWith('Error') ? <span style={{ color: 'var(--p-red)' }}>{line}</span>
                      : line}
                  </div>
                ))}
              </div>
            )}
            {run.status === 'running' && (
              <button
                onClick={(e) => { e.stopPropagation(); onStop(run.taskId); }}
                style={{
                  marginTop: 8,
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '3px 10px', borderRadius: 5,
                  border: '1px solid var(--p-red)',
                  background: 'color-mix(in srgb, var(--p-red) 15%, transparent)',
                  color: 'var(--p-red)',
                  fontSize: 10, fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <Square style={{ width: 8, height: 8 }} />
                Stop
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
