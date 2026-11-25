---
"@vibeflow-tools/cli": minor
---

An agent no longer gets its own operations handed back to it — without any configuration.

Until now the echo filter only worked if you exported `$VIBEFLOW_ACTOR`: with it unset (the default) every write was stamped `actor: agent` with no identity, so `vibeflow notifications --follow` delivered the agent's own edits to the agent. Observed in practice: nine notifications after one batch of ticket updates.

The identity is now derived from the **ancestor pi session process** (`pi-<pid>`), because that is the one fact the writer and its follower already share: a CLI write and its follower descend from the same pi, a peer agent from a different one, and a user's own terminal from none at all. So:

- your own operations are no longer delivered to you;
- every other agent's and every user's still are;
- `$VIBEFLOW_ACTOR` still wins when set (explicit intent is never overridden);
- with no pi ancestor and no variable there is no identity at all, and nothing is suppressed — a wrong guess degrades to noise, never to silence.

The match is on the harness process itself (executable `pi`, or `node` running `pi-coding-agent`), not on any command line that happens to mention it — that looseness had two processes in one session deriving different ids.
