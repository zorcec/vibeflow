---
"@vibeflow-tools/cli": patch
---

Remove the empty gap before card titles.

A card with no status mark rendered an empty slot, leaving a visible gap before
its title — indistinguishable from a badge that had failed to load. This affected
every card without a verdict in the review and done lanes, including all Research
tasks, which can never carry one.

A card that draws no mark now renders nothing at all: no box, and no reserved
space. Titles in a lane with mixed marks no longer share one x-offset; that
alignment guarantee is deliberately given up, because a gap that reads as a
broken badge is worse than a ragged left edge.
