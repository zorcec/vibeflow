---
"@vibeflow-tools/cli": patch
---

Remove guidance that pointed at a browser extension that does not exist. The `/inject` page's Content-Security-Policy note now tells pages with a strict policy to allowlist the Vibeflow server origin in their own `script-src` and `connect-src` (a build-time change, no `unsafe-eval` needed), and notes the bookmarklet and console snippet only work where the page's policy already permits them. The removed proxy-mode error now points at the `/inject` page instead.
