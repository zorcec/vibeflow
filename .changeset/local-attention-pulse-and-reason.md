<!-- highlight -->
---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Local kanban needs-attention round 2 parity. The bell pulse (`attention-breathe`) is now pinned in the CLI-served stylesheet (mirror of the shared UI rule), and an external `tasks --edit --set-attention --comment` write surfaces live in an open detail panel: the flag diff records the amber-tinted `attention` change row and the panel refetches comments so the reason comment lands next to it without a reload.
