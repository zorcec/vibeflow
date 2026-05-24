import React from 'react';
import { createPortal } from 'react-dom';
import { Bot, Play, Square, Trash2, Clock, GitBranch, FolderTree, ChevronDown, Search } from 'lucide-react';
import type { Task, AgentRun, AgentStatus } from '../types';

interface Props {
  task: Task;
  run: AgentRun | undefined;
  onRun: (taskId: string, model: string, agent?: string) => void;
  onStop: (taskId: string) => void;
  onDequeue: (taskId: string) => void;
  /** Optional dynamic models from OpenCode CLI */
  models?: { id: string; label: string; provider: string; recommended?: boolean }[];
  /** Default model from user settings — used as initial selection when task has no model */
  defaultModel?: string;
  /** Default agent from user settings — used as initial selection when task has no agent */
  defaultAgent?: string;
  /** Called when the selected model changes */
  onModelChange?: (model: string) => void;
  /** Available agents from OpenCode CLI */
  agents?: { id: string; name: string; scope: string }[];
  /** Called when the selected agent changes */
  onAgentChange?: (agent: string) => void;
  /** When false, the Run button is disabled and a message is shown */
  cliAvailable?: boolean;
}

// OpenCode models in provider/model format (fallback when dynamic models unavailable)
// These are real model IDs that opencode supports — verified against `opencode models` output.
export const DEFAULT_MODELS = [
  // OpenCode built-in free models
  { id: 'opencode/hy3-preview-free', label: 'Hy3 Preview (Free)', provider: 'OpenCode', recommended: true },
  { id: 'opencode/minimax-m2.5-free', label: 'MiniMax M2.5 (Free)', provider: 'OpenCode', recommended: true },
  { id: 'opencode/nemotron-3-super-free', label: 'Nemotron 3 Super (Free)', provider: 'OpenCode', recommended: true },
  // OpenCode Go models (fast, affordable)
  { id: 'opencode-go/deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'OpenCode Go', recommended: true },
  { id: 'opencode-go/qwen3.5-plus', label: 'Qwen 3.5 Plus', provider: 'OpenCode Go', recommended: true },
  { id: 'opencode-go/qwen3.6-plus', label: 'Qwen 3.6 Plus', provider: 'OpenCode Go' },
  { id: 'opencode-go/minimax-m2.5', label: 'MiniMax M2.5', provider: 'OpenCode Go' },
  { id: 'opencode-go/minimax-m2.7', label: 'MiniMax M2.7', provider: 'OpenCode Go' },
  { id: 'opencode-go/kimi-k2.5', label: 'Kimi K2.5', provider: 'OpenCode Go' },
  { id: 'opencode-go/glm-5', label: 'GLM 5', provider: 'OpenCode Go' },
  // GitHub Copilot models
  { id: 'github-copilot/gpt-4o', label: 'GPT-4o (Copilot)', provider: 'GitHub Copilot', recommended: true },
  { id: 'github-copilot/gpt-4.1', label: 'GPT-4.1 (Copilot)', provider: 'GitHub Copilot' },
  { id: 'github-copilot/claude-haiku-4.5', label: 'Claude Haiku 4.5 (Copilot)', provider: 'GitHub Copilot' },
  { id: 'github-copilot/gpt-5-mini', label: 'GPT-5 Mini (Copilot)', provider: 'GitHub Copilot' },
  // OpenRouter free models
  { id: 'openrouter/google/gemma-3-12b-it:free', label: 'Gemma 3 12B (Free)', provider: 'OpenRouter' },
  { id: 'openrouter/anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku', provider: 'OpenRouter' },
  { id: 'openrouter/anthropic/claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', provider: 'OpenRouter' },
  // Anthropic (requires API key)
  { id: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4', provider: 'Anthropic' },
  { id: 'anthropic/claude-opus-4-20250514', label: 'Claude Opus 4', provider: 'Anthropic' },
  // OpenAI (requires API key)
  { id: 'openai/gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  { id: 'openai/gpt-4-turbo', label: 'GPT-4 Turbo', provider: 'OpenAI' },
  // Google (requires API key)
  { id: 'google/gemini-2-5-pro', label: 'Gemini 2.5 Pro', provider: 'Google' },
  { id: 'google/gemini-2-0-flash-exp', label: 'Gemini 2.0 Flash', provider: 'Google' },
  // Ollama (local, requires Ollama running)
  { id: 'ollama/llama-3-1-8b', label: 'Llama 3.1 8B', provider: 'Ollama' },
  { id: 'ollama/qwen2-5-coder', label: 'Qwen 2.5 Coder', provider: 'Ollama' },
];

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return '';
  const diff = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

// Searchable model picker component — exported for reuse in SettingsModal
export function ModelPicker({
  value,
  onChange,
  disabled = false,
  models = DEFAULT_MODELS
}: {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  models?: { id: string; label: string; provider: string; recommended?: boolean }[];
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [filter, setFilter] = React.useState('');
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  const availableModels = models.length > 0 ? models : DEFAULT_MODELS;
  const selectedModel = availableModels.find(m => m.id === value);

  const filteredModels = React.useMemo(() => {
    if (!filter) return availableModels;
    const lower = filter.toLowerCase();
    return availableModels.filter(m =>
      m.label.toLowerCase().includes(lower) ||
      m.provider.toLowerCase().includes(lower) ||
      m.id.toLowerCase().includes(lower)
    );
  }, [filter, availableModels]);

  // Group models by provider
  const groupedModels = React.useMemo(() => {
    const groups: Record<string, typeof availableModels> = {};
    for (const model of filteredModels) {
      if (!groups[model.provider]) groups[model.provider] = [];
      groups[model.provider].push(model);
    }
    return groups;
  }, [filteredModels, availableModels]);

  const [dropdownRect, setDropdownRect] = React.useState<DOMRect | null>(null);

  function openDropdown() {
    if (disabled) return;
    setIsOpen(prev => !prev);
    // Measure button position for portal placement
    requestAnimationFrame(() => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setDropdownRect(rect);
      }
    });
  }

  function closeDropdown() {
    setIsOpen(false);
    setFilter('');
    setDropdownRect(null);
  }

  // Close on outside click (check both button container and portaled dropdown)
  React.useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (containerRef.current && containerRef.current.contains(target)) return;
      if (dropdownRef.current && dropdownRef.current.contains(target)) return;
      closeDropdown();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // Keyboard navigation
  React.useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeDropdown();
      }
    }
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [isOpen]);

  const dropdown = isOpen && dropdownRect ? createPortal(
    <div ref={dropdownRef} data-model-picker-dropdown style={{
      position: 'fixed',
      left: dropdownRect.left,
      bottom: window.innerHeight - dropdownRect.top + 4,
      width: dropdownRect.width,
      background: 'var(--p-surface)', border: '1px solid var(--p-border)',
      borderRadius: 8, boxShadow: 'var(--p-shadow-lg)', zIndex: 100000,
      maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column',
    }}>
          {/* Search input */}
          <div style={{ padding: 8, borderBottom: '1px solid var(--p-border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: 'var(--p-bg-2)', borderRadius: 6, border: '1px solid var(--p-border)' }}>
              <Search style={{ width: 12, height: 12, color: 'var(--p-text-g)', flexShrink: 0 }} />
              <input
                type="text"
                placeholder="Filter models..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                autoFocus
                style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 12, color: 'var(--p-text)', outline: 'none' }}
              />
            </div>
          </div>

          {/* Model list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 4 }}>
            {Object.entries(groupedModels).map(([provider, models]) => (
              <div key={provider}>
                <div style={{ padding: '6px 10px 4px', fontSize: 10, fontWeight: 600, color: 'var(--p-text-g)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {provider}
                </div>
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => { onChange(m.id); closeDropdown(); }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px', borderRadius: 5, border: 'none', background: value === m.id ? 'color-mix(in srgb, var(--p-purple) 12%, transparent)' : 'transparent',
                      color: value === m.id ? 'var(--p-purple-300)' : 'var(--p-text-m)', fontSize: 12,
                      cursor: 'pointer', textAlign: 'left', transition: 'background .1s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = value === m.id ? 'color-mix(in srgb, var(--p-purple) 15%, transparent)' : 'var(--p-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = value === m.id ? 'color-mix(in srgb, var(--p-purple) 12%, transparent)' : 'transparent'; }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
                    {m.recommended && (
                      <span style={{ fontSize: 8, fontWeight: 600, padding: '1px 4px', borderRadius: 3, background: 'var(--p-purple)', color: '#fff', flexShrink: 0 }}>
                        Rec
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
            {filteredModels.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--p-text-g)' }}>
                No models match "{filter}"
              </div>
            )}
          </div>
        </div>
    , document.body) : null;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={openDropdown}
        disabled={disabled}
        style={{
          width: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, padding: '8px 12px', borderRadius: 7,
          border: `1px solid ${isOpen ? 'var(--p-purple-300)' : 'var(--p-border)'}`,
          background: 'var(--p-bg-2)', color: 'var(--p-text-m)', fontSize: 12,
          cursor: disabled ? 'not-allowed' : 'pointer', transition: 'all .12s',
          opacity: disabled ? 0.6 : 1,
        }}
        onMouseEnter={(e) => {
          if (!disabled) e.currentTarget.style.borderColor = 'var(--p-purple-300)';
        }}
        onMouseLeave={(e) => {
          if (!disabled) e.currentTarget.style.borderColor = isOpen ? 'var(--p-purple-300)' : 'var(--p-border)';
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedModel?.label || 'Select model'}
          </span>
          {selectedModel?.recommended && (
            <span style={{ fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3, background: 'var(--p-purple)', color: '#fff', flexShrink: 0 }}>
              Recommended
            </span>
          )}
        </span>
        <ChevronDown style={{ width: 14, height: 14, color: 'var(--p-text-g)', flexShrink: 0, transition: 'transform .15s', transform: isOpen ? 'rotate(180deg)' : undefined }} />
      </button>
      {dropdown}
    </div>
  );
}

/** Simple agent picker dropdown */
export function AgentPicker({
  value,
  onChange,
  disabled = false,
  agents
}: {
  value: string;
  onChange: (agentId: string) => void;
  disabled?: boolean;
  agents: { id: string; name: string; scope: string }[];
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  const selectedAgent = agents.find(a => a.id === value);

  function openDropdown() {
    if (disabled) return;
    setIsOpen(prev => !prev);
  }

  function closeDropdown() {
    setIsOpen(false);
  }

  // Close on outside click (check both button container and portaled dropdown)
  React.useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (containerRef.current && containerRef.current.contains(target)) return;
      if (dropdownRef.current && dropdownRef.current.contains(target)) return;
      closeDropdown();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={openDropdown}
        disabled={disabled}
        style={{
          width: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, padding: '8px 12px', borderRadius: 7,
          border: `1px solid ${isOpen ? 'var(--p-purple-300)' : 'var(--p-border)'}`,
          background: 'var(--p-bg-2)', color: selectedAgent ? 'var(--p-text)' : 'var(--p-text-m)', fontSize: 12,
          cursor: disabled ? 'not-allowed' : 'pointer', transition: 'all .12s',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          <Bot style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--p-purple-300)' }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedAgent?.name || 'Select agent'}
          </span>
          {selectedAgent && (
            <span style={{ fontSize: 9, fontWeight: 500, padding: '1px 5px', borderRadius: 3, background: 'var(--p-border)', color: 'var(--p-text-g)', flexShrink: 0 }}>
              {selectedAgent.scope}
            </span>
          )}
        </span>
        <ChevronDown style={{ width: 14, height: 14, color: 'var(--p-text-g)', flexShrink: 0, transition: 'transform .15s', transform: isOpen ? 'rotate(180deg)' : undefined }} />
      </button>
      {isOpen && createPortal(
        <div ref={dropdownRef} data-agent-picker-dropdown style={{
          position: 'fixed',
          left: containerRef.current?.getBoundingClientRect().left ?? 0,
          bottom: window.innerHeight - (containerRef.current?.getBoundingClientRect().top ?? 0) + 4,
          width: containerRef.current?.getBoundingClientRect().width ?? 200,
          background: 'var(--p-surface)', border: '1px solid var(--p-border)',
          borderRadius: 8, boxShadow: 'var(--p-shadow-lg)', zIndex: 100000,
          maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column',
        }}>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => { onChange(a.id); closeDropdown(); }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 12px', borderRadius: 5, border: 'none', background: value === a.id ? 'color-mix(in srgb, var(--p-purple) 12%, transparent)' : 'transparent',
                color: value === a.id ? 'var(--p-purple-300)' : 'var(--p-text-m)', fontSize: 12,
                cursor: 'pointer', textAlign: 'left', transition: 'background .1s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = value === a.id ? 'color-mix(in srgb, var(--p-purple) 15%, transparent)' : 'var(--p-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = value === a.id ? 'color-mix(in srgb, var(--p-purple) 12%, transparent)' : 'transparent'; }}
            >
              <Bot style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--p-purple-300)' }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              <span style={{ fontSize: 9, fontWeight: 500, padding: '1px 4px', borderRadius: 3, background: 'var(--p-border)', color: 'var(--p-text-g)', flexShrink: 0 }}>
                {a.scope}
              </span>
            </button>
          ))}
        </div>
        , document.body)}
    </div>
  );
}

function StatusChip({ status }: { status: AgentStatus }) {
  // Minimalistic dot + text design
  const colors: Record<AgentStatus, string> = {
    idle: 'var(--p-text-g)',
    queued: 'var(--p-amber)',
    running: 'var(--p-blue)',
    done: 'var(--p-green)',
    failed: 'var(--p-red)',
  };

  const labels: Record<AgentStatus, string> = {
    idle: 'Idle',
    queued: 'Queued',
    running: 'Running',
    done: 'Completed',
    failed: 'Failed',
  };

  const [dotVisible, setDotVisible] = React.useState(true);

  // Blink effect for running state
  React.useEffect(() => {
    if (status !== 'running') return;
    const interval = setInterval(() => setDotVisible(v => !v), 800);
    return () => { clearInterval(interval); setDotVisible(true); };
  }, [status]);

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 11, fontWeight: 500, color: colors[status],
    }}>
      {/* Blinking dot for running, static for others */}
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: colors[status],
        opacity: status === 'running' ? (dotVisible ? 1 : 0.3) : 1,
        transition: 'opacity 0.3s ease',
      }} />
      {labels[status]}
    </span>
  );
}

/** Parse a single opencode JSON event into a human-readable React node. */
function renderLogLine(line: string): React.ReactNode | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Try to parse as opencode JSON event
  if (trimmed.startsWith('{')) {
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;

      // Text response from the model
      if (event.type === 'text' && typeof event.part === 'object' && event.part) {
        const part = event.part as Record<string, unknown>;
        const text = typeof part.text === 'string' ? part.text : '';
        if (text) {
          return (
            <span style={{ color: '#e2e8f0' }}>
              {text}
            </span>
          );
        }
        return null;
      }

      // Tool use event
      if (event.type === 'tool_use' && typeof event.part === 'object' && event.part) {
        const part = event.part as Record<string, unknown>;
        if (part.type === 'tool') {
          const tool = typeof part.tool === 'string' ? part.tool : 'tool';
          const state = (typeof part.state === 'object' && part.state ? part.state : {}) as Record<string, unknown> & { metadata?: { output?: unknown } };
          const input = (typeof state.input === 'object' && state.input ? state.input : {}) as Record<string, unknown>;
          const output = state.output ?? state.metadata?.output;
          const error = state.error;
          const status = typeof state.status === 'string' ? state.status : '';

          return (
            <div style={{ color: '#94a3b8' }}>
              <div>
                <span style={{ color: '#60a5fa' }}>→ {tool}</span>
                {typeof input.description === 'string' && input.description && (
                  <span>: {input.description}</span>
                )}
                {typeof input.command === 'string' && input.command && !input.description && (
                  <span>: {input.command}</span>
                )}
                {typeof input.filePath === 'string' && input.filePath && (
                  <span>: {input.filePath}</span>
                )}
                {typeof input.url === 'string' && input.url && (
                  <span>: {input.url}</span>
                )}
              </div>
              {error !== undefined && (
                <div style={{ marginLeft: 12, color: '#ef4444', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 9 }}>
                  {String(error).slice(0, 2000)}
                </div>
              )}
              {output !== undefined && error === undefined && (
                <div style={{ marginLeft: 12, color: status === 'error' ? '#ef4444' : '#22c55e', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 9 }}>
                  {String(output).slice(0, 2000)}
                </div>
              )}
            </div>
          );
        }
      }

      // Hide step_start / step_finish for cleaner output
      if (event.type === 'step_start' || event.type === 'step_finish') {
        return null;
      }

      // Error event
      if (event.type === 'error') {
        const msg = typeof event.message === 'string' ? event.message : JSON.stringify(event);
        return (
          <span style={{ color: '#ef4444' }}>
            Error: {msg}
          </span>
        );
      }

      // Unknown JSON event — show type only
      return (
        <span style={{ color: '#64748b', fontSize: 9 }}>
          [{String(event.type)}]
        </span>
      );
    } catch {
      // Not valid JSON, fall through to non-JSON rendering
    }
  }

  // Command / status messages
  if (trimmed.startsWith('opencode run')) {
    return (
      <span style={{ color: '#64748b', fontSize: 9 }}>
        $ {trimmed.split('\n')[0]}
      </span>
    );
  }
  if (trimmed.startsWith('✓') || trimmed.startsWith('✗') || trimmed.startsWith('▶')) {
    return <span>{trimmed}</span>;
  }

  // Non-JSON line (stderr, rtk messages, etc.)
  return <span style={{ color: '#94a3b8' }}>{trimmed}</span>;
}

/** Renders agent logs with opencode JSON events parsed into human-readable output. */
function ParsedLogViewer({ logs, status }: { logs: string[]; status: AgentStatus }) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Join all raw log chunks, split by lines, and filter empty lines
  const allText = logs.join('');
  const lines = React.useMemo(() => {
    return allText.split('\n').filter((l) => l.trim().length > 0);
  }, [allText]);

  // Auto-scroll to bottom while running
  React.useEffect(() => {
    if (containerRef.current && status === 'running') {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines.length, status]);

  return (
    <div
      ref={containerRef}
      style={{
        background: '#0a0c10', border: '1px solid var(--p-border)', borderRadius: 7,
        padding: '10px 12px', fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 10,
        lineHeight: 1.65, color: '#a3e635', maxHeight: 200, overflowY: 'auto',
      }}
    >
      {lines.map((line, i) => {
        const rendered = renderLogLine(line);
        if (rendered === null) return null;
        return (
          <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {rendered}
          </div>
        );
      }).filter(Boolean)}
      {status === 'running' && (
        <span style={{ color: '#a3e635' }}>▌</span>
      )}
    </div>
  );
}

export function AgentTab({ task, run, onRun, onStop, onDequeue, models, defaultModel, defaultAgent, onModelChange, agents, onAgentChange, cliAvailable = true }: Props) {
  const availableModels = models && models.length > 0 ? models : DEFAULT_MODELS;
  const [model, setModel] = React.useState(task.model ?? defaultModel ?? availableModels[0]?.id);
  const [agent, setAgent] = React.useState(task.agent ?? defaultAgent ?? agents?.[0]?.id ?? '');

  function handleModelChange(newModel: string) {
    setModel(newModel);
    onModelChange?.(newModel);
  }

  function handleAgentChange(newAgent: string) {
    setAgent(newAgent);
    onAgentChange?.(newAgent);
  }

  function handleRun() {
    onRun(task.id, model, agent || undefined);
  }

  // Notify parent of initial model/agent selection so "Run Agent" uses the
  // displayed defaults even when the user never touches the dropdowns.
  React.useEffect(() => {
    onModelChange?.(model);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (agent) onAgentChange?.(agent);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync model/agent when task changes externally (e.g., another user patches it)
  React.useEffect(() => {
    if (task.model && task.model !== model) setModel(task.model);
    if (task.agent && task.agent !== agent) setAgent(task.agent);
  }, [task.model, task.agent]);

  // Apply defaultAgent when agents load and no agent is set
  React.useEffect(() => {
    if (!agent && defaultAgent) {
      setAgent(defaultAgent);
    }
  }, [defaultAgent]);

  const [elapsed, setElapsed] = React.useState('');

  React.useEffect(() => {
    if (run?.status !== 'running') return;
    const interval = setInterval(() => setElapsed(formatElapsed(run.startedAt)), 1000);
    setElapsed(formatElapsed(run.startedAt));
    return () => clearInterval(interval);
  }, [run?.status, run?.startedAt]);

  const status: AgentStatus = run?.status ?? 'idle';
  const worktree = run?.worktree ?? `wt/task-${task.id.slice(0, 8)}`;
  const branch = run?.branch ?? `agent/task-${task.id.slice(0, 8)}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Status row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <StatusChip status={status} />
        {status === 'running' && elapsed && (
          <span style={{ fontSize: 11, color: 'var(--p-text-g)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Clock style={{ width: 10, height: 10 }} />
            {elapsed}
          </span>
        )}
        {status === 'queued' && (
          <span style={{ fontSize: 11, color: 'var(--p-text-g)' }}>Waiting for current run to finish…</span>
        )}
      </div>

      {/* Idle / ready state */}
      {status === 'idle' && !cliAvailable && (
        <div style={{
          borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.6,
          background: 'color-mix(in srgb, var(--p-red) 6%, transparent)',
          border: '1px solid color-mix(in srgb, var(--p-red) 25%, transparent)',
          color: 'var(--p-red-300)',
        }}>
          <strong>Local CLI not connected.</strong> Agent runs require the local CLI server to be running. Start it with <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 4 }}>vibeflow serve</code> and refresh this page.
        </div>
      )}
      {status === 'idle' && cliAvailable && (
        <div style={{
          borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.6,
          background: 'color-mix(in srgb, var(--p-purple) 6%, transparent)',
          border: '1px solid color-mix(in srgb, var(--p-purple) 25%, transparent)',
          color: 'var(--p-purple-300)',
        }}>
          <strong>Ready to run.</strong> The agent will create an isolated worktree, read the task description, and implement a solution. When done, you&apos;ll review the diff and merge.
        </div>
      )}

      {/* Queued state */}
      {status === 'queued' && (
        <div style={{
          borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.6,
          background: 'color-mix(in srgb, var(--p-amber) 6%, transparent)',
          border: '1px solid color-mix(in srgb, var(--p-amber) 25%, transparent)',
          color: 'var(--p-amber-300)',
        }}>
          <strong>⏳ Queued</strong> — another task is currently running. This task will start automatically when the queue is free.
        </div>
      )}

      {/* Model selector */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--p-text-g)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Model</div>
        <ModelPicker
          value={model}
          onChange={handleModelChange}
          disabled={status === 'running' || status === 'queued'}
          models={availableModels}
        />
      </div>

      {/* Agent selector */}
      {agents && agents.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--p-text-g)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Agent</div>
          <AgentPicker
            value={agent}
            onChange={handleAgentChange}
            disabled={status === 'running' || status === 'queued'}
            agents={agents}
          />
        </div>
      )}

      {/* Worktree info */}
      <div style={{ border: '1px solid var(--p-border)', borderRadius: 8, padding: 10, background: 'var(--p-bg-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--p-text-g)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Worktree</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--p-text-m)' }}>
          <FolderTree style={{ width: 10, height: 10, color: 'var(--p-text-g)', flexShrink: 0 }} />
          <span style={{ fontFamily: 'monospace', fontSize: 10 }}>{worktree}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--p-text-m)' }}>
          <GitBranch style={{ width: 10, height: 10, color: 'var(--p-text-g)', flexShrink: 0 }} />
          <span style={{ fontFamily: 'monospace', fontSize: 10 }}>{branch}</span>
        </div>
      </div>

      {/* Live logs */}
      {run && run.logs.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--p-text-g)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Live Output</div>
            {status === 'running' && (
              <span style={{ fontSize: 10, color: 'var(--p-blue-300)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--p-blue)', animation: 'pulse 1s ease-in-out infinite' }} />
                Streaming...
              </span>
            )}
          </div>
          <ParsedLogViewer logs={run.logs} status={status} />
        </div>
      )}

      {/* Agent metadata from task */}
      {task.agent && !run && (task.commits?.length ?? 0) > 0 && (
        <div style={{ fontSize: 11, color: 'var(--p-text-g)' }}>
          Last agent: <span style={{ color: 'var(--p-purple-300)' }}>{task.agent}</span>
          {task.model && <> · model <span style={{ color: 'var(--p-purple-300)' }}>{task.model}</span></>}
        </div>
      )}

      {/* Session metadata footer */}
      {run && (run.status === 'done' || run.status === 'failed') && (
        <div style={{
          borderTop: '1px solid var(--p-border)',
          paddingTop: 10,
          display: 'flex',
          flexWrap: 'wrap',
          gap: '10px 16px',
          fontSize: 10,
          color: 'var(--p-text-g)',
        }}>
          {run.durationMs != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Clock style={{ width: 10, height: 10 }} />
              {formatDuration(run.durationMs)}
            </span>
          )}
          {run.totalTokens != null && run.totalTokens > 0 && (
            <span title={`${run.inputTokens ?? 0} input · ${run.outputTokens ?? 0} output${run.reasoningTokens ? ` · ${run.reasoningTokens} reasoning` : ''}`}>
              {formatTokens(run.totalTokens)} tokens
            </span>
          )}
          {run.cost != null && run.cost > 0 && (
            <span style={{ color: 'var(--p-green)' }}>
              ${run.cost.toFixed(4)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins > 0) return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  return `${secs}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
