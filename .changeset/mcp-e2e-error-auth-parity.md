---
"@vibeflow-tools/cli": patch
---

MCP e2e coverage: error paths + gate matrix, auth, hang, claim race, manifest parity.

- New e2e suites: mcp-errors (20), mcp-auth (7+1 skip), mcp-hang (3), mcp-claim-race (4), mcp-parity (5)
- Fix ESM crash in src/core/lock.ts: CJS `require("node:path")` in the lock-wait path threw "Dynamic require" under ESM dist
- Un-corrupt tests/e2e/init.test.ts and verify-tools.test.ts (trailing garbage / wrong import depth); verify-page-wide documented skip (orphaned, needs verify+browser harness)
- mcp-helpers: spawnApiServer host option + spawnCli helper
