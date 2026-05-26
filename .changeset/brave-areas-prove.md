---
"@vibeflow-tools/cli": patch
---

Change CLI console log prefix from [Proto] to [Vibeflow]

All console.log and console.error calls in the server now use
`[Vibeflow]` as the prefix instead of the legacy `[Proto]` name.
