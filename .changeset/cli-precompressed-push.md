---
"@vibeflow-tools/cli": patch
---

Compress text artifacts before upload so the server stores them verbatim

Push (`uploadTaskFiles`) now brotli-compresses eligible text attachments
(md, html, non-baseline json, txt, csv) at quality 5 via `node:zlib` before
uploading, declaring the payload form per file with the `x-content-encoding:
br` header. The server stores verified uploads verbatim as the at-rest form
— one encode total, zero server CPU. Images and `baseline-*.json` travel raw
with no header, and inputs that do not shrink stay plain, so pulls and older
clients are unaffected.
