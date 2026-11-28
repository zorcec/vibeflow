---
"@vibeflow-tools/cli": minor
"@vibeflow-tools/ui": minor
---

**The Watching popover can show what an agent is doing right now.**

A follower that has set a free-text status (`vibeflow agents status "<text>"`) gets ONE extra line under its activity row in the "Watching" popover: an amber `status` label, the report, and its age in the badge's own `41 s ago` wording. Absence stays absence — a follower that never sent one gets no line, never a placeholder. Past five minutes the line goes muted and reads `idle` with the raw text gone, so a stale report can never lie about freshness; a long report ellipsises instead of widening the popover.

Counts, aggregates and the legacy `user — N agents` fallback are untouched, and the badge's polling contract is unchanged: open-only refreshes, exactly one read while closed.
