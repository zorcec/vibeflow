---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

show the verification verdict in the activity feed, the task details, and on hover

The panel's activity feed now flags the entries that carry a verification
verdict: a status transition that carries the task's tri-state `verified` flag
and lands in a verdict lane renders as `activity-verify--pass|--fail`, and the
`**Cannot verify:**` system comment renders as `activity-verify--cannot` —
each with a minimal left-border accent and a hover tooltip that says what the
verdict means. Ordinary comments and verdict-less status changes stay plain
(the lane gate stays single-sourced in `VerifyIndicator`).

The detail panel header shows a `Verification` row with the shared
`VerifyIndicator` glyph and label, and the glyph's hover tooltip now spells
out who attested what ("the agent attested this task IS / is NOT implemented
correctly") on the card, the child rows and the details pane. The
`Cannot verify` marker regex was also corrected to match the string the CLI
actually writes (`**Cannot verify:**` — colon inside the bold), which the
feed's special rendering never matched before.
