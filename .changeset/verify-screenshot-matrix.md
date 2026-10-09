---
"@vibeflow-tools/cli": patch
---

Apply the image matrix to verify screenshots at capture time

`vibeflow verify` no longer writes the raw Playwright PNG. The screenshot
bytes run through the shared T1 pipeline (`transformImageBytes`, pure
JS/wasm — no sharp, no new deps) before storage: viewports wider than
1920px resize to width 1920 with WebP q80, narrower screenshots transcode
to lossless WebP. The file is stored under its true extension
(`verify-screenshot.webp`, with a raw-PNG fallback keeping `.png` when the
transform fails) and `SYSTEM_FILE_NAMES` recognizes the new `.webp` name —
alongside the legacy `.png` — so the evidence `system` flag semantics are
unchanged.
