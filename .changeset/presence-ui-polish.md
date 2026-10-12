---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/shared": patch
---

Polished presence UI for live collaboration

Remote cursor colours now come from a fixed 12-colour palette, so two people in the same description always get easily told-apart colours that stay the same for each person across sessions; the peer-name flag on each cursor keeps a text shadow so it stays readable on the lightest colours. The card activity badge shows a pencil while someone is typing and an eye while they are only viewing, matching the presence line's wording. The presence line in the task panel wraps instead of overflowing on narrow screens. No behaviour changes: presence stays informational and never locks editing.
