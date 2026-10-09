---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Replace lossy-JPEG-everything image ingest with the measured image matrix

Uploads and pastes no longer transcode every image to lossy JPEG. A shared,
dependency-injected transform module (`@vibeflow-tools/ui/kanban`, browser-safe
core + one `@jsquash` wasm path for every runtime, pure JS/wasm only — no
native dependencies) implements the policy: PNG/BMP/TIFF of any size become
lossless WebP, images wider than 1920px are resized to width 1920 with WebP
q80, narrow JPEGs are kept with only their metadata stripped (byte-level
APP/COM drop, no re-encode), and GIF/SVG pass through untouched. Stored files
always carry their true extension (`.webp`/`.jpg`/`.png`), and JPEG input
never takes the lossless-WebP branch. The wasm binaries load lazily from the
CLI server on first transform, so the overlay and board bundles stay small;
where no codec is reachable the original bytes are kept with a matching
extension instead of failing.

### Highlights

- Images stop being squeezed into lossy JPEG: screenshots, uploads and pastes
  transcode to lossless WebP (bit-exact), and anything wider than 1920px is
  downscaled to 1920 at q80 — smaller files for storage and for agent image
  tokens. Pure wasm, no native dependencies: it works on every machine out of
  the box.
