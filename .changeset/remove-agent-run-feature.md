---
"@vibeflow-tools/cli": minor
---

Remove the experimental agent-run feature and its supporting packages.

- Delete the `opencode-telegram-bridge` package.
- Remove the agent-run API endpoints (`/api/agent/run`, `/api/agent/stop`, `/api/agent/agents`, `/api/agent/models`) and the `models` tRPC procedure from the CLI server.
- Remove the Agent tab, model/agent pickers, agent queue panel, and multi-select (long-press) mode from the kanban UI.
- Remove agent/model-related settings keys (`defaultModel`, `perTypeModels`, `defaultModelBug/Research/Task`, `defaultAgent`, `experimentalAgents`).
- Remove `AgentStatus`/`AgentRun` types and the `getModels`/`getAgents` API methods from `@vibeflow-tools/ui`.
