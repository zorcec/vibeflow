---
"@vibeflow-tools/cli": patch
---

Fixed `vibeflow auth login` failing with "Device code expired" when this machine already has a token: the CLI now answers the login server's reuse signal — adopting the existing stored token when one is present, or rotating to a fresh token when none is — and fails loudly on unknown login responses instead of hanging until expiry.
