---
"@vibeflow-tools/cli": patch
---

Fixed a login dead-end where every fresh device authorization ended at "No boards found" even though the account has boards. The login step now reads both boards-list formats, follows all result pages, and maps the current row shape. The empty-account message now says where to create a board and which command re-runs the pick.
