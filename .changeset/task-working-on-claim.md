---
"@vibeflow-tools/ui": minor
"@vibeflow-tools/cli": minor
---

**A task's detail panel can say who is working on it — and stops saying it when
that stops being true.**

A follower now reports the task its agent was last seen taking up: the claim is
set from a delivered claim / in-progress event, cleared when the task leaves
in-progress, and carried on the heartbeat the follower already sends. It rides
the same feed answer the per-task activity log already reads, so the panel asks
once instead of twice.

The claim expires. One clock is the follower's own liveness — an entry whose
heartbeat stops is gone, claim included, so a claim can never outlive the
process that made it. The other is the work itself: a follower that has
delivered nothing for that task for 90 seconds stops claiming it, so an agent
that went quiet reads as `idle, watching` rather than as a frozen "working on"
line. The panel applies the same age rule a second time, so a claim that
arrives stale from a board that did not filter it still renders as idle.

Hosted notes for the next release: the release must also serve the live claims
on the notifications read and accept them on the subscriber heartbeat, and the
app has to pass its notifications endpoint to the panel — the package is
consumed as published, so that wiring is a release-time change, not a local
patch.
