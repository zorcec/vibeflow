---
"@vibeflow-tools/cli": patch
---

The Watching badge no longer lists the same agent several times.

A follower's registry key was a random UUID minted per process, so every restart registered a **new** subscriber and the badge counted the same agent again — the reported symptom was "8 agents following" with eight identical rows named `agent`, all carrying the same delivered event, from eight follower processes started over one session.

The key is now derived from the agent identity: `pi-<pid>` (the pi session — a restarted follower inside it is the same agent) or `$VIBEFLOW_ACTOR` (an explicit name). Re-registering is idempotent by design, but only when the key is the same, so a restart now replaces its own row instead of adding one. Different sessions have different pids, so two real agents stay two rows, and a follower with no identity at all still gets a random key — nothing distinguishes those, and a shared key would hide the second one.
