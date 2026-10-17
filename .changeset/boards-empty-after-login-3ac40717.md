---
"@vibeflow-tools/cli": patch
---

Fixed a login dead-end where every fresh device authorization ended at "No boards found" even though the account HAS boards (ticket 3ac40717). The login step read the boards list with the legacy `{ workspaces }` envelope, while the boards endpoint answers the v0 `{ items, nextCursor }` envelope — so the parse always came back empty. The step now reads both envelopes, follows result pages, and maps the v0 row shape (falling back to the app base for the board URL). The empty-account message now says where to create a board and which command reruns the pick.
