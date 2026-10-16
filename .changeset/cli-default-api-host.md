---
"@vibeflow-tools/cli": patch
---

Fix `vibeflow login` (and push/settings) failing with `404 Not Found`: the CLI defaulted to the retired
`freemium.vibeflow.tools` host. The default API host is now `https://app.vibeflow.tools`, the local board's
workspace-origin allowlist accepts the new host, and the stale docs/security text was corrected.
