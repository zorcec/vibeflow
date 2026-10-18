---
"@vibeflow-tools/cli": patch
---

Upload compression now follows the shared policy (`@vibeflow-tools/shared/compression`), including `baseline-*.json` artifacts which the server has always accepted compressed. Removes the CLI-only baseline exclusion that made large baseline uploads travel (and bill) uncompressed.
