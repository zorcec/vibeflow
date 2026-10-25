---
"@vibeflow-tools/cli": patch
---

Fixed auth resolution falsely unlinking a valid project when one account has boards in two projects: `resolveProjectAuth` treated the credential store's single `workspaceId` per host as a hard match, so a second login (naming the other board) flipped the first project to "Not logged in" even though the account-scoped token was valid for both boards. The project pointer now picks the board and the credential only proves identity — a `workspaceId` mismatch still resolves online on the pointer's board. The device-login adopt path likewise keeps an existing project pointer as-is instead of silently re-pointing it to whatever board last won the shared credential store (only a pointer-less project adopts the credential's board).
