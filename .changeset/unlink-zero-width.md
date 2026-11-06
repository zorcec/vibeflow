---
"@vibeflow-tools/ui": patch
---

Fix: the Unlink button in the child-row detail tree collapses to zero width at rest — it previously stayed laid out at ~54px behind `opacity: 0`, permanently stealing row space. It now contracts (with `min-width: 0`) and reveals on hover and on keyboard focus, matching the CopyIdButton reveal contract.
