---
"@vibeflow-tools/cli": patch
---

A local notification log that was deleted or cleared is now reported as a `gap` instead of as silence.

The two "1:1" notification backends answered `gap` differently for an empty store with a `since` cursor: the hosted ring said `true`, the local store said `false`. Neither was wrong — memory has no persistence, so an empty ring can only mean a restart took the events, while an empty JSONL usually means nothing was ever written — but the difference was unstated, and one case was genuinely dangerous: a follower holding a cursor against a **destroyed** local log was handed an empty page and told nothing was lost, so it advanced past events that no longer existed.

A `.vibeflow/notifications.epoch` marker (written on the first event, never removed by a reset) makes the two cases distinguishable. Now:

- a fresh project with a `since` cursor reports no gap — nothing was lost;
- a log that once held events but is now empty reports a gap, with the same "events you never saw are gone" meaning the hosted ring gives;
- both headers say plainly where the two backends differ instead of claiming they are identical.

Residual, documented: a project whose log was destroyed *before* any event was appended after this change still looks fresh.
