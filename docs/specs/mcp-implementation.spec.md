# MCP Server Implementation Spec

> **Task:** `e08b8d7f6c75f553dc55c0e9a540b0`
> **Status:** Implementation-ready
> **Date:** 2026-09-03

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI (Commander)                                                │
│  packages/cli/src/index.ts                                      │
│         │                                                       │
│         ▼                                                       │
│  packages/cli/src/core/operations.ts  ◀── NEW: shared ops       │
│         ▲                                                       │
│         │                                                       │
├─────────┼───────────────────────────────────────────────────────┤
│         │                                                       │
│  packages/cli/src/server/server.ts (REST + tRPC)                │
│         ▲                                                       │
│         │                                                       │
│  packages/cli/src/mcp/            ◀── NEW: MCP server           │
│    ├── http.ts                    (Express mount)               │
│    ├── server.ts                  (McpServer per session)       │
│    ├── manifest.ts                (tool catalogue)              │
│    ├── schema.ts                  (zod → JSON Schema)           │
│    └── adapters.ts                (manifest → operations)       │
│                                                                 │
│  POST|GET|DELETE /api/mcp                                       │
│  StreamableHTTPServerTransport                                  │
│  enableJsonResponse: true                                       │
└─────────────────────────────────────────────────────────────────┘
```

**Key property:** MCP and CLI are siblings, not parent/child. Both call `core/operations.ts`.

---

## 2. File Structure

### New Files

```
packages/cli/src/core/operations.ts       # Shared operations layer
packages/cli/src/mcp/http.ts              # Express mount
packages/cli/src/mcp/server.ts            # McpServer factory
packages/cli/src/mcp/manifest.ts          # Tool catalogue
packages/cli/src/mcp/schema.ts            # Zod → JSON Schema
packages/cli/src/mcp/adapters.ts          # Manifest → operations
packages/cli/src/mcp/auth.ts              # MCP auth middleware
packages/cli/tests/unit/mcp/drift.test.ts # Drift test
packages/cli/tests/unit/mcp/tools.test.ts # Tool unit tests
```

### Modified Files

```
packages/cli/src/index.ts                 # Refactor to use operations.ts
packages/cli/src/server/server.ts         # Mount /api/mcp
packages/cli/package.json                 # Add @modelcontextprotocol/sdk
```

---

## 3. Operations Layer Design

### `packages/cli/src/core/operations.ts`

```typescript
import { z } from 'zod';

// Context passed to every operation
export interface OperationContext {
  projectDir: string;
  mode: 'local' | 'saas';
  userId?: string;
  workspaceId?: string;
  dryRun?: boolean;
}

// Result wrapper
export interface OperationResult<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; retryable?: boolean; suggestion?: string };
  steps?: string[];  // For compound operations
}

// ── list_tasks ─────────────────────────────────────────────────────
export const ListTasksInput = z.object({
  status: z.enum(['backlog', 'todo', 'in-progress', 'review', 'done']).optional(),
  type: z.enum(['Task', 'Bug', 'Feature', 'Enhancement', 'Research']).optional(),
  user: z.string().optional(),
  tag: z.array(z.string()).optional(),
  limit: z.number().min(0).default(5),
  fields: z.array(z.string()).optional(),
});
export type ListTasksInput = z.infer<typeof ListTasksInput>;

export async function listTasks(ctx: OperationContext, input: ListTasksInput): Promise<OperationResult<Task[]>>;

// ── get_task ───────────────────────────────────────────────────────
export const GetTaskInput = z.object({
  id: z.string().min(1),
  fields: z.array(z.string()).optional(),
});
export type GetTaskInput = z.infer<typeof GetTaskInput>;

export async function getTask(ctx: OperationContext, input: GetTaskInput): Promise<OperationResult<Task>>;

// ── create_task ────────────────────────────────────────────────────
export const CreateTaskInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['backlog', 'todo', 'in-progress', 'review', 'done']).default('todo'),
  type: z.enum(['Task', 'Bug', 'Feature', 'Enhancement', 'Research']).default('Task'),
  priority: z.enum(['Critical', 'High', 'Medium', 'Low']).default('Medium'),
  tags: z.array(z.string()).optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export async function createTask(ctx: OperationContext, input: CreateTaskInput): Promise<OperationResult<Task>>;

// ── update_task ────────────────────────────────────────────────────
export const UpdateTaskInput = z.object({
  id: z.string().min(1),
  status: z.enum(['backlog', 'todo', 'in-progress', 'review', 'done']).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  branch: z.string().optional(),
  comment: z.string().optional(),
  commit_message: z.string().optional(),
  skip_verify: z.boolean().default(false),
  dry_run: z.boolean().default(false),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

export async function updateTask(ctx: OperationContext, input: UpdateTaskInput): Promise<OperationResult<Task>>;

// ── claim_next_task ────────────────────────────────────────────────
export const ClaimNextTaskInput = z.object({
  type: z.enum(['Task', 'Bug', 'Feature', 'Enhancement', 'Research']).optional(),
  user: z.string().optional(),
  tag: z.array(z.string()).optional(),
  dry_run: z.boolean().default(false),
});
export type ClaimNextTaskInput = z.infer<typeof ClaimNextTaskInput>;

export async function claimNextTask(ctx: OperationContext, input: ClaimNextTaskInput): Promise<OperationResult<Task>>;

// ── add_comment ────────────────────────────────────────────────────
export const AddCommentInput = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  author: z.enum(['agent', 'user']).default('agent'),
});
export type AddCommentInput = z.infer<typeof AddCommentInput>;

export async function addComment(ctx: OperationContext, input: AddCommentInput): Promise<OperationResult<Comment>>;

// ── attach_file ────────────────────────────────────────────────────
export const AttachFileInput = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  content_b64: z.string().min(1),  // Base64-encoded content
});
export type AttachFileInput = z.infer<typeof AttachFileInput>;

export async function attachFile(ctx: OperationContext, input: AttachFileInput): Promise<OperationResult<FileInfo>>;

// ── export_prompt ──────────────────────────────────────────────────
export const ExportPromptInput = z.object({
  id: z.string().optional(),
  ids: z.array(z.string()).optional(),
  format: z.enum(['markdown', 'json']).default('markdown'),
});
export type ExportPromptInput = z.infer<typeof ExportPromptInput>;

export async function exportPrompt(ctx: OperationContext, input: ExportPromptInput): Promise<OperationResult<string>>;

// ── verify_task ────────────────────────────────────────────────────
export const VerifyTaskInput = z.object({
  id: z.string().min(1),
  url: z.string().url().optional(),
  timeout_ms: z.number().min(1000).max(300000).default(60000),
});
export type VerifyTaskInput = z.infer<typeof VerifyTaskInput>;

export async function verifyTask(ctx: OperationContext, input: VerifyTaskInput): Promise<OperationResult<VerifyResult>>;

// ── push_tasks ─────────────────────────────────────────────────────
export const PushTasksInput = z.object({
  workspace: z.string().optional(),
  keep_local_files: z.boolean().default(true),
  dry_run: z.boolean().default(false),
});
export type PushTasksInput = z.infer<typeof PushTasksInput>;

export async function pushTasks(ctx: OperationContext, input: PushTasksInput): Promise<OperationResult<PushResult>>;
```

---

## 4. Manifest Schema

### `packages/cli/src/mcp/manifest.ts`

```typescript
import { z } from 'zod';
import { ZodType } from '@modelcontextprotocol/sdk';

export interface ToolManifest {
  name: string;
  title: string;
  description: string;
  cliRef: {
    command: string;
    flags: string[];
  };
  category: 'task-read' | 'task-write' | 'task-mutate' | 'admin';
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  input: ZodType;
  run: (ctx: OperationContext, input: unknown) => Promise<OperationResult<unknown>>;
}

export const manifest: ToolManifest[] = [
  {
    name: 'list_tasks',
    title: 'List tasks',
    description: 'List tasks with optional filters. Returns task list with configurable fields.',
    cliRef: { command: 'tasks', flags: ['--status', '--type', '--user', '--tag', '--limit', '--fields'] },
    category: 'task-read',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: ListTasksInput,
    run: (ctx, input) => listTasks(ctx, input as ListTasksInput),
  },
  // ... (all 10 tools)
];
```

---

## 5. Tool Definitions (Complete Schemas)

### 5.1 `list_tasks`

- **Input:** `{ status?, type?, user?, tag[]?, limit=5, fields[]? }`
- **Output:** `{ tasks: Task[], total: number }`
- **Annotations:** readOnly, idempotent

### 5.2 `get_task`

- **Input:** `{ id, fields[]? }`
- **Output:** `Task` (with comments and files)
- **Annotations:** readOnly, idempotent
- **Error:** `TASK_NOT_FOUND` if ID doesn't exist

### 5.3 `create_task`

- **Input:** `{ title, description?, status?, type?, priority?, tags?[] }`
- **Output:** `Task` (created)
- **Annotations:** non-destructive

### 5.4 `update_task`

- **Input:** `{ id, status?, title?, description?, branch?, comment?, commit_message?, skip_verify?, dry_run? }`
- **Output:** `Task` (updated) + `steps[]` for compound operations
- **Annotations:** conditional-destructive
- **Enforcement:**
  - `status: "review"` → requires verify (unless `skip_verify: true` or non-UI task)
  - `commit_message` → triggers git commit + push (unless `dry_run: true`)
  - Research tasks → requires attached .md report

### 5.5 `claim_next_task`

- **Input:** `{ type?, user?, tag[]?, dry_run? }`
- **Output:** `Task` (claimed) or error if none available
- **Annotations:** non-destructive-but-stateful
- **Atomicity:** Optimistic CAS + mutex

### 5.6 `add_comment`

- **Input:** `{ id, text, author?('agent') }`
- **Output:** `Comment` (created)
- **Annotations:** non-destructive

### 5.7 `attach_file`

- **Input:** `{ id, filename, content_b64 }`
- **Output:** `FileInfo`
- **Annotations:** non-destructive
- **Security:** No `path` parameter (prevents arbitrary file read)

### 5.8 `export_prompt`

- **Input:** `{ id?, ids?[], format?('markdown') }`
- **Output:** `string` (formatted prompt)
- **Annotations:** readOnly

### 5.9 `verify_task`

- **Input:** `{ id, url?, timeout_ms? }`
- **Output:** `VerifyResult` (ok, evidence files, selector info)
- **Annotations:** expensive, serialised
- **Isolation:** Semaphore of 1, hard timeout

### 5.10 `push_tasks`

- **Input:** `{ workspace?, keep_local_files?=true, dry_run? }`
- **Output:** `PushResult` (pushed count, skipped count)
- **Annotations:** destructive

---

## 6. Transport Setup

### `packages/cli/src/mcp/http.ts`

```typescript
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Express, Request, Response } from 'express';

// Per-session server map
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

export function mountMcp(app: Express, projectDir: string) {
  // Exempt /api/mcp from CORS reflection
  app.use('/api/mcp', mcpCorsExempt);
  
  // Auth middleware
  app.use('/api/mcp', mcpAuth);
  
  // Handle MCP requests
  app.all('/api/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    
    if (req.method === 'POST') {
      // New session or existing session
      if (!sessionId) {
        // Initialize new session
        const server = createMcpServer(projectDir);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
        });
        
        await server.connect(transport);
        sessions.set(transport.sessionId!, { server, transport });
        
        // Handle the request
        await transport.handleRequest(req, res);
      } else {
        // Existing session
        const session = sessions.get(sessionId);
        if (!session) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
        await session.transport.handleRequest(req, res);
      }
    } else if (req.method === 'GET') {
      // SSE stream for notifications
      if (!sessionId) {
        res.status(400).json({ error: 'Session ID required for GET' });
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await session.transport.handleRequest(req, res);
    } else if (req.method === 'DELETE') {
      // Close session
      if (!sessionId) {
        res.status(400).json({ error: 'Session ID required for DELETE' });
        return;
      }
      const session = sessions.get(sessionId);
      if (session) {
        await session.transport.close();
        sessions.delete(sessionId);
      }
      res.status(200).json({ ok: true });
    }
  });
  
  // Cleanup on server shutdown
  process.on('SIGTERM', async () => {
    for (const [id, session] of sessions) {
      await session.transport.close();
    }
    sessions.clear();
  });
}
```

---

## 7. Security Model

### 7.1 Auth

- **Local mode:** Loopback-only by default (`--host 0.0.0.0` requires explicit token)
- **Token:** Reuse CLI device-flow token from `~/.vibeflow/auth.json`
- **Header:** `Authorization: Bearer <token>`

### 7.2 CORS

- Exempt `/api/mcp` from `useCors()` reflection
- Only allow specific origins if needed

### 7.3 Loopback Protection

- Default bind: `localhost`
- `--host 0.0.0.0` requires `--mcp-token <token>` flag
- Or: `VIBEFLOW_MCP_TOKEN` env var

### 7.4 Rate Limiting

- 100 requests/minute per session
- 10 verify_task calls/hour (expensive)

---

## 8. Drift Test Design

### `packages/cli/tests/unit/mcp/drift.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { manifest } from '../../../src/mcp/manifest';
import { Command } from 'commander';

describe('MCP drift test', () => {
  it('every non-hidden CLI command is mapped or excluded', () => {
    const program = new Command();
    // ... parse Commander tree
    
    const mappedCommands = new Set(manifest.map(m => m.cliRef.command));
    const excluded = new Set(['serve', 'kanban', 'login', 'logout', 'watch', 'telemetry', 'auth', 'changelog']);
    
    for (const cmd of getAllCommands(program)) {
      if (!cmd.hidden) {
        expect(mappedCommands.has(cmd.name) || excluded.has(cmd.name)).toBe(true);
      }
    }
  });
  
  it('every tasks option appears in manifest or excluded set', () => {
    const tasksCmd = getCommand(program, 'tasks');
    const allFlags = getAllFlags(tasksCmd);
    
    const mappedFlags = new Set(
      manifest
        .filter(m => m.cliRef.command === 'tasks')
        .flatMap(m => m.cliRef.flags)
    );
    const excluded = new Set(['--json', '--dry-run']); // Handled differently in MCP
    
    for (const flag of allFlags) {
      expect(mappedFlags.has(flag) || excluded.has(flag)).toBe(true);
    }
  });
  
  it('every cliRef refers to existing command/flag', () => {
    for (const tool of manifest) {
      const cmd = getCommand(program, tool.cliRef.command);
      expect(cmd).toBeDefined();
      
      for (const flag of tool.cliRef.flags) {
        expect(getFlag(cmd, flag)).toBeDefined();
      }
    }
  });
  
  it('snapshot of tool names matches fixture', () => {
    const toolNames = manifest.map(m => m.name).sort();
    expect(toolNames).toMatchSnapshot();
  });
});
```

---

## 9. Implementation Phases

### Phase 1: Operations Layer (Day 1-2)

1. Create `packages/cli/src/core/operations.ts`
2. Extract operation bodies from `index.ts` into operations.ts
3. Refactor `index.ts` to call operations.ts
4. Ensure all existing tests pass

### Phase 2: MCP Core (Day 2-3)

1. Install `@modelcontextprotocol/sdk`
2. Create `packages/cli/src/mcp/` directory
3. Implement manifest.ts with all 10 tools
4. Implement schema.ts (zod → JSON Schema)
5. Implement server.ts (McpServer factory)
6. Implement http.ts (Express mount)
7. Implement auth.ts (token validation)
8. Mount `/api/mcp` in server.ts

### Phase 3: Drift Test (Day 3)

1. Create `tests/unit/mcp/drift.test.ts`
2. Create `tests/unit/mcp/tools.test.ts`
3. Ensure drift test passes

### Phase 4: Integration Testing (Day 3-4)

1. Manual testing with MCP Inspector
2. Test all 10 tools with all options
3. Test error cases
4. Test auth
5. Test session management

### Phase 5: Documentation & Release (Day 4)

1. Update README with MCP instructions
2. Create changeset (minor)
3. Build and verify

---

## 10. Testing Strategy

### Unit Tests

- Operations layer: mock fs, git, db
- Manifest: validate all tools have required fields
- Schema: validate zod schemas produce valid JSON Schema

### Integration Tests

- Start server, connect MCP client, call each tool
- Test auth (valid token, invalid token, no token)
- Test session management (create, use, close)
- Test error handling (invalid input, not found, etc.)

### Manual Testing Checklist

For each tool, test:

1. Happy path (valid input)
2. Missing required fields
3. Invalid field values
4. Non-existent task ID
5. Permission errors (if applicable)
6. Dry run mode (for mutating tools)
7. Concurrent access (for claim_next_task)

---

## 11. Open Questions (Resolved)

| Question | Resolution |
| ---------- | ------------ |
| Q1: Does MCP support SaaS/online mode? | Yes, via operations layer (mode-aware) |
| Q2: Local-mode auth model? | Loopback-only default + optional token |
| Q3: Ship delete_task in P1? | No, defer to P2 |
| Q4: Are tRPC procedures consumed? | Yes, keep tRPC; MCP is parallel surface |
| Q5: SDK dependency acceptable? | Yes, add to CLI package.json |
