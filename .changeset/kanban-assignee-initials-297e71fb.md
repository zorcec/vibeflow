---
"@vibeflow-tools/ui": patch
---

Kanban cards show assignee initials instead of the full name, and the pill clears when the item leaves the active lane. The assignee pill in the card badge cluster rendered the stored full name ("Tomislav Zorčec") as card text; it now renders `presenceInitials` ("TZ") — the same helper the presence chips and the live-activity badge already use — with the full name kept in the hover title and the overflow tooltip's accessible name. The pill is derived synchronously from the lane (in-progress only, done cards stay title-only) with no cache or timer, so when the item is closed the status is gone on the next render. Clearing on assignee inactivity is intentionally not shipped: the pill is a stored assignment, not live presence, and no assignment timestamp, heartbeat, or disconnect reaches the card — expiring it client-side would corrupt data without a protocol change.
