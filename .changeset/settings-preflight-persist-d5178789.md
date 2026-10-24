---
"@vibeflow-tools/cli": patch
---

The CLI no longer re-checks remote settings on every invocation: the 5-minute settings check is now remembered across processes, so back-to-back commands issue zero settings requests. Account or token rotation and independent settings edits re-arm the check, and a corrupt or unwritable cache fails open.
