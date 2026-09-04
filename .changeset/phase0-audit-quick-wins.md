---
"@vibeflow-tools/cli": minor
---

Phase 0 quick wins from audit findings:

- Fix double decodeURIComponent on file upload (was throwing URIError on %)
- Fix requireSameOrigin prefix-hole (<http://localhost.attacker.com> was accepted)
- Add gitUserName to /api/project and tRPC project query
- Use config port instead of hardcoded 3700 in verify
- MCP auth: timing-safe token compare, remove dead localhost check, remove stale cache
- MCP http: session reaper uses lastSeen (not createdAt), add disposeMcp()
- Extract isLoopbackOrigin to core/loopback.ts for testability
- Remove dead code: gating.ts canMoveToReview, getCommentCount, onTaskRefClick handler
- Add tests: loopback origin, timing-safe compare
