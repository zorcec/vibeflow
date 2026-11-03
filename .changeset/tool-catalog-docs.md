---
"@vibeflow-tools/cli": patch
---

MCP tool docs are now generated from code (single source of truth): `packages/cli/tool-catalog.json` is projected from `packages/cli/src/mcp/manifest.ts` (13 tools, including `get_file` and `pull`), the root README tool table lists all 13, and `pnpm check:docs` fails when docs and catalog disagree.
