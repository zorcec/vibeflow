import React from 'react';
import { X, Settings, Layout, ShieldCheck } from 'lucide-react';
import type { TaskStatus, AppSettings } from '../types';
import { COLUMNS } from './KanbanBoard';
import { ModalBase } from './ModalBase';

type SettingsTab = 'board' | 'enforcement';

interface Props {
  open: boolean;
  visibleCols: TaskStatus[];
  settings: AppSettings;
  onClose: () => void;
  onSave: (visibleCols: TaskStatus[], settings: Partial<AppSettings>) => void;
}

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'board', label: 'Board', icon: <Layout className="w-3.5 h-3.5" /> },
  { id: 'enforcement', label: 'Enforcement', icon: <ShieldCheck className="w-3.5 h-3.5" /> },
];

export function SettingsModal({ open, visibleCols, settings, onClose, onSave }: Props) {
  const [activeTab, setActiveTab] = React.useState<SettingsTab>('board');
  const [colState, setColState] = React.useState<Record<TaskStatus, boolean>>({} as Record<TaskStatus, boolean>);
  const [autoCommit, setAutoCommit] = React.useState(settings.autoCommit ?? false);
  const [autoComment, setAutoComment] = React.useState(settings.autoComment ?? false);
  const [autoPush, setAutoPush] = React.useState(settings.autoPush ?? false);
  const [createBranch, setCreateBranch] = React.useState(settings.createBranch ?? false);
  const [requireVerifyBeforeReview, setRequireVerifyBeforeReview] = React.useState(settings.requireVerifyBeforeReview ?? false);

  React.useEffect(() => {
    if (!open) return;
    const m: Record<TaskStatus, boolean> = {} as Record<TaskStatus, boolean>;
    COLUMNS.forEach(c => { m[c.id] = visibleCols.includes(c.id); });
    setColState(m);
    setAutoCommit(settings.autoCommit ?? false);
    setAutoComment(settings.autoComment ?? false);
    setAutoPush(settings.autoPush ?? false);
    setCreateBranch(settings.createBranch ?? false);
    setRequireVerifyBeforeReview(settings.requireVerifyBeforeReview ?? false);
    setActiveTab('board');
  }, [open, visibleCols, settings]);

  function handleApply() {
    const newCols = COLUMNS.filter(c => colState[c.id]).map(c => c.id);
    onSave(newCols, { autoCommit, autoComment, autoPush, createBranch, requireVerifyBeforeReview });
    onClose();
  }

  function toggleCol(id: TaskStatus) {
    setColState(prev => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <ModalBase
      open={open}
      onClose={onClose}
      id="settings-modal"
      width="min(460px, 95vw)"
      icon={<Settings style={{ width: 14, height: 14, color: 'var(--p-text-g)' }} />}
      title="Settings"
      headerActions={
        <button
          id="settings-close"
          onClick={onClose}
          style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--p-text-g)', cursor: 'pointer', transition: 'background .12s,color .12s' }}
          onMouseOver={(e) => { e.currentTarget.style.background = 'var(--p-surface)'; e.currentTarget.style.color = 'var(--p-text-m)'; }}
          onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--p-text-g)'; }}
        >
          <X style={{ width: 14, height: 14 }} />
        </button>
      }
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            id="settings-cancel"
            onClick={onClose}
            className="dp-status-btn"
            style={{ padding: '5px 14px', fontSize: 12 }}
          >Cancel</button>
          <button
            id="settings-apply"
            onClick={handleApply}
            style={{ padding: '5px 14px', fontSize: 12, fontWeight: 500, borderRadius: 6, border: '1px solid color-mix(in srgb, var(--p-purple) 55%, transparent)', background: 'color-mix(in srgb, var(--p-purple) 18%, transparent)', color: 'var(--p-purple-300)', cursor: 'pointer', transition: 'background .12s' }}
            onMouseOver={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--p-purple) 28%, transparent)'; }}
            onMouseOut={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--p-purple) 18%, transparent)'; }}
          >Apply</button>
        </div>
      }
    >
      {/* Tab bar */}
      <div className="dp-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`dp-tab${activeTab === tab.id ? ' active' : ''}`}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab: Board */}
      {activeTab === 'board' && (
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="dp-meta-label">Visible Columns</div>
          {COLUMNS.map(col => (
            <label key={col.id} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
              <input
                id={`settings-col-${col.id}`}
                type="checkbox"
                checked={colState[col.id] ?? true}
                onChange={() => toggleCol(col.id)}
                style={{ width: 14, height: 14, accentColor: col.color, cursor: 'pointer' }}
              />
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: col.color, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: 'var(--p-text-m)' }}>{col.label}</span>
            </label>
          ))}
        </div>
      )}

      {/* Tab: Enforcement */}
      {activeTab === 'enforcement' && (
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <WorkflowToggle
            id="settings-verify-before-review"
            label="Require verify before review"
            description="CLI enforces vibeflow verify before setting status to review (skipped for tasks without URL/selector). The 'verified' flag persists until the task is moved back to in-progress."
            value={requireVerifyBeforeReview}
            onChange={setRequireVerifyBeforeReview}
          />
          <WorkflowToggle
            id="settings-auto-comment"
            label="Require comment on review"
            description="CLI enforces an implementation report when setting task status to review."
            value={autoComment}
            onChange={setAutoComment}
          />
          {/* Separator between comment and branch/commit/push options */}
          <div style={{ height: 1, background: 'var(--p-border)', marginTop: -4, marginBottom: -4 }} />
          <WorkflowToggle
            id="settings-create-branch"
            label="Require branch per task"
            description="CLI enforces a dedicated branch name when setting task status to review."
            value={createBranch}
            onChange={setCreateBranch}
          />
          <WorkflowToggle
            id="settings-auto-commit"
            label="Auto-commit on review"
            description="CLI automatically commits staged changes when setting task status to review."
            value={autoCommit}
            onChange={setAutoCommit}
          />
          <WorkflowToggle
            id="settings-auto-push"
            label="Auto-push after commit"
            description={`CLI pushes after auto-commit. Requires 'Auto-commit' to be ON.${autoCommit ? '' : ' (Enable Auto-commit first)'}`}
            value={autoPush && autoCommit}
            onChange={(v) => setAutoPush(v && autoCommit)}
          />
        </div>
      )}

    </ModalBase>
  );
}

interface WorkflowToggleProps {
  id: string;
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

function WorkflowToggle({ id, label, description, value, onChange }: WorkflowToggleProps) {
  return (
    <div>
      <div className="dp-meta-label" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--p-text-g)', marginBottom: 10 }}>{description}</div>
      <div id={id} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => onChange(!value)}>
        <div style={{ position: 'relative', width: 36, height: 20, flexShrink: 0 }}>
          <div style={{ width: 36, height: 20, borderRadius: 10, background: value ? 'var(--p-purple)' : 'var(--p-card)', border: `1px solid ${value ? 'var(--p-purple-300)' : 'var(--p-border)'}`, transition: 'all .15s' }} />
          <div style={{ position: 'absolute', top: 3, left: value ? 18 : 3, width: 14, height: 14, borderRadius: '50%', background: value ? 'var(--p-purple-300)' : 'var(--p-text-muted)', transition: 'all .15s' }} />
        </div>
        <span style={{ fontSize: 12, color: 'var(--p-text-g)' }}>{value ? 'On' : 'Off'}</span>
      </div>
    </div>
  );
}


