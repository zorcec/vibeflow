---
"@vibeflow-tools/ui": patch
---

Remove the "changed attention (clear → flagged)" activity row from the feed: flagging activity is not needed — the amber flag reason comment is the only feed record of a flag. `diffTaskFields` no longer emits an `attention` entry, and the shared feed renderer drops stored `attention` entries so legacy records resurface nothing. Bell, badge, flag state, and the amber reason-comment tint are unchanged on both the local board and the hosted web board (shared component).
