---
"@vibeflow-tools/cli": patch
---

Add `experimentalAgents` feature flag to gate all agent-related UI features. When disabled (default), the agent tab, agent queue, agent status badges, "Run Agents" multi-select toolbar, and agent settings are hidden from the kanban UI. The flag can be toggled in Settings > Agent.