---
"@vibeflow-tools/cli": patch
---

Online comment prose survives both spellings. The hosted record spells the comment field `body` while the local record and the v0 contract spell it `text`, and each side of the mapping read only one spelling — so hosted `body` rows were dropped from comment hydration and contract `text` rows mapped to empty local text. Both directions now project through one helper: `text` and `body` both land, a genuinely omitted field stays absent (never invented, never `"undefined"`), and an empty body stays empty.
