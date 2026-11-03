---
"@vibeflow-tools/api-core": patch
---

Sync hosted MCP tool declarations with the CLI manifest (TDQS follow-up): claim_next_task, get_file and pull descriptions plus create_task/update_task (--fields), attach_file (--attach) and pull (--prefer-local) cliRef flags now match `packages/cli/src/mcp/manifest.ts`, so remote clients see the same usage tips as local ones. No behavior change.
