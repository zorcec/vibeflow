---
"@vibeflow-tools/cli": patch
---

fix: silence opencode stderr when not installed

Add `stdio: "pipe"` to all `execSync` calls for opencode commands in
`server.ts` and `trpc.ts`. Without this option, the OS "command not found"
error was written to the terminal each time the Kanban board started and
fetched models/agents — even though the errors were caught and handled.
Users who don't have opencode installed should see no output about it.
