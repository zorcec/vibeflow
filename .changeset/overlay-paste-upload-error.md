---
"@vibeflow-tools/cli": patch
---

Fix overlay paste `uploadTaskFile` swallowing rejected uploads: check the upload POST response status and throw with the server error detail (parity with the board `uploadFile` fix), so a failed overlay paste lands in the visible paste-error UI via `pasteFailureMessage` instead of resolving as success.
