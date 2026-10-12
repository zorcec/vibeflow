---
"@vibeflow-tools/ui": patch
---

Presence copy now agrees with the Activity tab

The detail-panel presence line and the card activity badge render the comments area as "activity" ("Ana is in activity", "Ana editing · activity") to match the Activity tab and the activity feed. Internal identifiers are unchanged: tab keys, `PresenceArea` wire values, `data-testid`s and the comment data model still use "comments".
