---
"@vibeflow-tools/cli": patch
---

Stop shipping demo media in the npm tarball. Removed the orphaned `docs/demo/` directory (5 GIFs, 5 MP4s, 5 WEBMs, 1 PNG) and dropped it from the package `files` list — the README already links the showcase from `https://www.vibeflow.tools/assets/demo/showcase.gif`, so the local copies were unused. Package size drops from 28.1 MB to 1.1 MB.
