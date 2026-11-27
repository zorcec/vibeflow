---
"@vibeflow-tools/cli": minor
---

**Claim leases with a fencing token.** A status change to `in-progress` now
writes `{ holder, token, expiresAt }` in the same locked write as the status,
so two agents that both start before either writes can no longer both claim the
same task:

- TTL is 90 s (three follower heartbeats); a live agent renews every 30 s and
  pushes the expiry out again. A killed agent holds nothing past the TTL.
- An expired lease re-admits the task to the next claimant with a **new, higher
  token**. A write or renewal carrying an older token is **refused**, which is
  what stops a partitioned holder from taking the task back after a peer
  legitimately took over.
- The loser is told who has it and until when: `LEASE_HELD` / `LEASE_STALE`
  with `{ holder, token, expiresAt }`, exit code 5.
- `vibeflow tasks --edit <id> --lease-token <n>` renews the lease you hold.
- Lease state lives in `.vibeflow/leases/<taskId>.json` (sidecar, never on the
  task record), so it never reaches a pushed or shared record.
