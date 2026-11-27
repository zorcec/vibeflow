---
"@vibeflow-tools/cli": patch
---

**A 0-byte file is no longer dropped from the delta push while the summary counts it.**

`vibeflow push` on the delta path skipped every file whose bytes were empty —
including a real 0-byte file — while the run summary counted it, so a push
could report N files sent when the board received N-1. An emptied payload is
only the marker for "the board already has this file"; a genuine 0-byte file is
sent (it costs nothing) and the summary is now derived from the same rule the
archive writer uses, so the two can never disagree again.
