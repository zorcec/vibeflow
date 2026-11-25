---
"@vibeflow-tools/cli": minor
---

`vibeflow notifications --follow` now survives the network instead of dying on it.

Before, any failed poll — a deploy, a proxy reset, a single 503 — stopped the heartbeat, unregistered the watcher and ended the process. The agent went silent for good, and nothing announced it.

Now the follower classifies the failure and acts:

- **retry** transport failures, timeouts, 408/425/429 and 5xx, with bounded exponential backoff (500 ms → 30 s cap) and **full jitter**, so followers woken by the same outage don't retry on the same beat. A `Retry-After` from the board is obeyed (capped).
- **recover** from an expired cursor (`INVALID_SINCE`): drop the cursor, resume from the newest events, and say so — some may be missed, and silence there would be a lie.
- **stop** only when waiting cannot help: no project link, a usage refusal, or 401/403/422.

During an outage the watcher registration stays alive (a flaky feed path is not a dead board), the `--exec` child keeps running, and on recovery it re-announces immediately rather than waiting for the next heartbeat. One dim line when the feed goes down, one when it comes back — never one per attempt. The dedupe memory is bounded, so a follower left running for days doesn't grow.
