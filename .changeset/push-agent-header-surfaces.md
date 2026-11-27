---
"@vibeflow-tools/cli": patch
---

**A push no longer comes back at the agent that pushed it.**

The echo-filter header (`X-Vibeflow-Agent`) was only stamped on ordinary task
writes. Every bulk path — `vibeflow push` (the one-by-one create loop and the
tree import), link replay, file uploads, the delta archive, and the local
board's `POST /api/push` — sent no agent at all, so a follower was handed back
the events its own push caused.

All of them now build the header from one function (`agentHeader()`), the same
`resolveAgentIdentity()` the rest of the CLI uses. With no identity there is no
header — an unidentified write is delivered, because silence must never come
from an unknown identity.
