import React from 'react';
import { X, Settings, Layout, Workflow, Bot } from 'lucide-react';
import type { TaskStatus, AppSettings } from '../types';
import { COLUMNS } from './KanbanBoard';
import { ModalBase } from './ModalBase';
import { ModelPicker, AgentPicker, DEFAULT_MODELS } from './AgentTab';

type SettingsTab = 'board' | 'workflow' | 'agent';

interface Props {
  open: boolean;
  visibleCols: TaskStatus[];
  settings: AppSettings;
  onClose: () => void;
  onSave: (visibleCols: TaskStatus[], settings: Partial<AppSettings>) => void;
  /** Available models from OpenCode CLI */
  models?: { id: string; label: string; provider: string; recommended?: boolean }[];
  /** Available agents from OpenCode CLI */
  agents?: { id: string; name: string; scope: string }[];
}

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'board', label: 'Board', icon: <Layout className="w-3.5 h-3.5" /> },
  { id: 'workflow', label: 'Workflow', icon: <Workflow className="w-3.5 h-3.5" /> },
  { id: 'agent', label: 'Agent', icon: <Bot className="w-3.5 h-3.5" /> },
];

export function SettingsModal({ open, visibleCols, settings, onClose, onSave, models, agents }: Props) {
  const availableModels = models && models.length > 0 ? models : DEFAULT_MODELS;
  const [activeTab, setActiveTab] = React.useState<SettingsTab>('board');
  const [colState, setColState] = React.useState<Record<TaskStatus, boolean>>({} as Record<TaskStatus, boolean>);
  const [autoCommit, setAutoCommit] = React.useState(settings.autoCommit ?? false);
  const [autoComment, setAutoComment] = React.useState(settings.autoComment ?? false);
  const [autoPush, setAutoPush] = React.useState(settings.autoPush ?? false);
  const [createBranch, setCreateBranch] = React.useState(settings.createBranch ?? false);
  const [defaultModel, setDefaultModel] = React.useState(settings.defaultModel ?? '');
  const [defaultAgent, setDefaultAgent] = React.useState(settings.defaultAgent ?? 'build');
  const [perTypeModels, setPerTypeModels] = React.useState(settings.perTypeModels ?? false);
  const [defaultModelBug, setDefaultModelBug] = React.useState(settings.defaultModelBug ?? '');
  const [defaultModelResearch, setDefaultModelResearch] = React.useState(settings.defaultModelResearch ?? '');
  const [defaultModelTask, setDefaultModelTask] = React.useState(settings.defaultModelTask ?? '');
  const [experimentalAgents, setExperimentalAgents] = React.useState(settings.experimentalAgents ?? false);

  React.useEffect(() => {
    if (!open) return;
    const m: Record<TaskStatus, boolean> = {} as Record<TaskStatus, boolean>;
    COLUMNS.forEach(c => { m[c.id] = visibleCols.includes(c.id); });
    setColState(m);
    setAutoCommit(settings.autoCommit ?? false);
    setAutoComment(settings.autoComment ?? false);
    setAutoPush(settings.autoPush ?? false);
    setCreateBranch(settings.createBranch ?? false);
    setDefaultModel(settings.defaultModel ?? '');
    setDefaultAgent(settings.defaultAgent ?? 'build');
    setPerTypeModels(settings.perTypeModels ?? false);
    setDefaultModelBug(settings.defaultModelBug ?? '');
    setDefaultModelResearch(settings.defaultModelResearch ?? '');
    setDefaultModelTask(settings.defaultModelTask ?? '');
    setExperimentalAgents(settings.experimentalAgents ?? false);
    setActiveTab('board');
  }, [open, visibleCols, settings]);

  function handleApply() {
    const newCols = COLUMNS.filter(c => colState[c.id]).map(c => c.id);
    onSave(newCols, { autoCommit, autoComment, autoPush, createBranch, defaultModel, defaultAgent, perTypeModels, defaultModelBug, defaultModelResearch, defaultModelTask, experimentalAgents });
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

      {/* Tab: Workflow */}
      {activeTab === 'workflow' && (
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <WorkflowToggle
            id="settings-auto-comment"
            label="Comment after task implementation"
            description="Agent is instructed to add a summary comment after completing a task."
            value={autoComment}
            onChange={setAutoComment}
          />
          {/* Separator between comment and branch/commit/push options */}
          <div style={{ height: 1, background: 'var(--p-border)', marginTop: -4, marginBottom: -4 }} />
          <WorkflowToggle
            id="settings-create-branch"
            label="Create branch before implementation"
            description="Agent creates a descriptive branch before starting work (e.g. fix/bug-errors, feat/eye-toggle). Name reflects the work: lowercase, kebab-case, 2–5 words, prefix fix/feat/chore/docs."
            value={createBranch}
            onChange={setCreateBranch}
          />
          <WorkflowToggle
            id="settings-auto-commit"
            label="Commit after task implementation"
            description="Agent is instructed to stage and commit changes after each task."
            value={autoCommit}
            onChange={setAutoCommit}
          />
          <WorkflowToggle
            id="settings-auto-push"
            label="Push after task commit"
            description={`Agent is instructed to push after every commit. Requires 'Commit' to be ON.${autoCommit ? '' : ' (Enable Commit first)'}`}
            value={autoPush && autoCommit}
            onChange={(v) => setAutoPush(v && autoCommit)}
          />
        </div>
      )}

      {/* Tab: Agent */}
      {activeTab === 'agent' && (
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Experimental toggle */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none', marginBottom: 4 }}>
              <input
                id="settings-experimental-agents"
                type="checkbox"
                checked={experimentalAgents}
                onChange={() => setExperimentalAgents(!experimentalAgents)}
                style={{ width: 14, height: 14, accentColor: 'var(--p-purple)', cursor: 'pointer' }}
              />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--p-text-m)' }}>Enable agent features (experimental)</span>
            </label>
            <div style={{ fontSize: 11, color: 'var(--p-text-g)', marginLeft: 24 }}>Agent runs, queue, and model selection are experimental and may change.</div>
          </div>

          {!experimentalAgents && (
            <div style={{ padding: 16, borderRadius: 8, background: 'var(--p-bg-2)', border: '1px dashed var(--p-border)', textAlign: 'center', fontSize: 12, color: 'var(--p-text-g)' }}>
              Agent features are disabled. Toggle above to enable.
            </div>
          )}

          {experimentalAgents && (
            <>
              <div>
                <div className="dp-meta-label" style={{ marginBottom: 6 }}>Default Model</div>
                <div style={{ fontSize: 11, color: 'var(--p-text-g)', marginBottom: 10 }}>This model will be pre-selected when running the agent on a task.</div>
                <ModelPicker
                  value={defaultModel}
                  onChange={(id) => setDefaultModel(id === defaultModel ? '' : id)}
                  models={availableModels}
                />
              </div>

              {defaultModel && (
                <div style={{ padding: 10, borderRadius: 7, background: 'color-mix(in srgb, var(--p-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--p-green) 30%, transparent)', fontSize: 11, color: 'var(--p-green-300)' }}>
                  ✓ Default model set to: <strong>{availableModels.find(m => m.id === defaultModel)?.label}</strong>
                </div>
              )}

              {/* Default Agent */}
              <div>
                <div className="dp-meta-label" style={{ marginBottom: 6 }}>Default Agent</div>
                <div style={{ fontSize: 11, color: 'var(--p-text-g)', marginBottom: 10 }}>This agent will be used when running agent on a task without a specific agent set.</div>
                <AgentPicker
                  value={defaultAgent}
                  onChange={(id) => setDefaultAgent(id)}
                  agents={agents ?? []}
                />
              </div>

              {defaultAgent && (
                <div style={{ padding: 10, borderRadius: 7, background: 'color-mix(in srgb, var(--p-purple) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--p-purple) 30%, transparent)', fontSize: 11, color: 'var(--p-purple-300)' }}>
                  ✓ Default agent set to: <strong>{agents?.find(a => a.id === defaultAgent)?.name ?? defaultAgent}</strong>
                </div>
              )}

              {/* Separator */}
              <div style={{ height: 1, background: 'var(--p-border)', margin: '4px 0' }} />

              {/* Per-type models */}
              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none', marginBottom: 4 }}>
                  <input
                    id="settings-per-type-models"
                    type="checkbox"
                    checked={perTypeModels}
                    onChange={() => setPerTypeModels(!perTypeModels)}
                    style={{ width: 14, height: 14, accentColor: 'var(--p-purple)', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--p-text-m)' }}>Use different models per task type</span>
                </label>
                <div style={{ fontSize: 11, color: 'var(--p-text-g)', marginLeft: 24 }}>Override the default model for specific task types.</div>
              </div>

              {perTypeModels && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 24 }}>
                  <TypeModelPicker
                    id="dp-type-model-picker-bug"
                    label="Bug"
                    color="var(--p-red)"
                    value={defaultModelBug}
                    onChange={(id) => setDefaultModelBug(id === defaultModelBug ? '' : id)}
                    models={availableModels}
                  />
                  <TypeModelPicker
                    id="dp-type-model-picker-research"
                    label="Research"
                    color="var(--p-blue)"
                    value={defaultModelResearch}
                    onChange={(id) => setDefaultModelResearch(id === defaultModelResearch ? '' : id)}
                    models={availableModels}
                  />
                  <TypeModelPicker
                    id="dp-type-model-picker-task"
                    label="Task"
                    color="var(--p-green)"
                    value={defaultModelTask}
                    onChange={(id) => setDefaultModelTask(id === defaultModelTask ? '' : id)}
                    models={availableModels}
                  />
                </div>
              )}
            </>
          )}
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

interface TypeModelPickerProps {
  id: string;
  label: string;
  color: string;
  value: string;
  onChange: (id: string) => void;
  models: { id: string; label: string; provider: string; recommended?: boolean }[];
}

function TypeModelPicker({ id, label, color, value, onChange, models }: TypeModelPickerProps) {
  const selectedModel = models.find(m => m.id === value);
  return (
    <div id={id}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--p-text-m)' }}>{label}</span>
      </div>
      <ModelPicker value={value} onChange={onChange} models={models} />
      {selectedModel && (
        <div style={{ fontSize: 10, color: 'var(--p-text-g)', marginTop: 4, paddingLeft: 4 }}>
          → {selectedModel.label}
        </div>
      )}
    </div>
  );
}
