import type { Task, Comment, FileEntry, KanbanApi } from '@vibeflow-tools/ui/kanban';

const BASE = window.location.origin;
const API = `${BASE}/api/tasks`;

export const api: KanbanApi = {
  async getTasks(): Promise<{ tasks: Task[] }> {
    const r = await fetch(`${API}?_=${Date.now()}`, { cache: 'no-store' });
    return r.json() as Promise<{ tasks: Task[] }>;
  },

  async createTask(data: Partial<Task>): Promise<{ success: boolean; task?: Task }> {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json() as Promise<{ success: boolean; task?: Task }>;
  },

  async updateTask(id: string, data: Partial<Task>): Promise<{ success: boolean; task?: Task }> {
    const r = await fetch(`${API}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json() as Promise<{ success: boolean; task?: Task }>;
  },

  async deleteTask(id: string): Promise<void> {
    await fetch(`${API}/${id}`, { method: 'DELETE' });
  },

  async getComments(taskId: string): Promise<{ comments: Comment[] }> {
    const r = await fetch(`${API}/${taskId}/comments`);
    return r.json() as Promise<{ comments: Comment[] }>;
  },

  async addComment(taskId: string, text: string): Promise<void> {
    await fetch(`${API}/${taskId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'user', text, source: 'web' }),
    });
  },

  async updateComment(taskId: string, commentId: string, text: string): Promise<void> {
    await fetch(`${API}/${taskId}/comments/${commentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  },

  async deleteComment(taskId: string, commentId: string): Promise<void> {
    await fetch(`${API}/${taskId}/comments/${commentId}`, { method: 'DELETE' });
  },

  async getFiles(taskId: string): Promise<{ files: FileEntry[] }> {
    const r = await fetch(`${API}/${taskId}/files`);
    return r.json() as Promise<{ files: FileEntry[] }>;
  },

  async uploadFile(taskId: string, file: File): Promise<void> {
    const buf = await file.arrayBuffer();
    await fetch(`${API}/${taskId}/files/${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
  },

  async deleteFile(taskId: string, filename: string): Promise<void> {
    await fetch(`${API}/${taskId}/files/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  },

  async getProject(): Promise<{ name?: string; gitUserName?: string; branch?: string | null }> {
    const r = await fetch(`${BASE}/api/project`);
    return r.json() as Promise<{ name?: string; gitUserName?: string; branch?: string | null }>;
  },

  async getCopilotStatus(): Promise<{ authenticated: boolean; username?: string }> {
    const r = await fetch(`${BASE}/api/copilot/status`);
    return r.json() as Promise<{ authenticated: boolean; username?: string }>;
  },

  async copilotLogin(): Promise<{ launched?: boolean }> {
    const r = await fetch(`${BASE}/api/copilot/login`, { method: 'POST' });
    return r.json().catch(() => ({})) as Promise<{ launched?: boolean }>;
  },

  async getSettings(): Promise<Record<string, unknown>> {
    const r = await fetch(`${BASE}/api/settings`, { cache: 'no-store' });
    return r.json() as Promise<Record<string, unknown>>;
  },

  async saveSettings(settings: Record<string, unknown>): Promise<void> {
    await fetch(`${BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
  },

  wsUrl(): string {
    const wsScheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsScheme}//${window.location.host}`;
  },

  async getModels(): Promise<{ models: { id: string; label: string; provider: string }[]; error: string | null }> {
    const r = await fetch(`${BASE}/trpc/models`, { cache: 'no-store' });
    const data = await r.json() as { result?: { data?: { models: { id: string; label: string; provider: string }[]; error: string | null } } };
    return data?.result?.data ?? { models: [], error: 'Invalid response' };
  },

  async getAgents(): Promise<{ agents: { id: string; name: string; scope: string }[]; error: string | null }> {
    const r = await fetch(`${BASE}/api/agent/agents`, { cache: 'no-store' });
    const data = await r.json() as { agents: { id: string; name: string; scope: string }[] };
    return { agents: data.agents ?? [], error: null };
  },
};
