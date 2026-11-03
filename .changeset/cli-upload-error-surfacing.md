---
"@vibeflow-tools/cli": patch
---

Fix CLI board `uploadFile` swallowing rejected uploads: check the upload POST response status and throw with the server error detail (parity with the web adapter), so the detail panel shows the upload-error box instead of a success chip.
