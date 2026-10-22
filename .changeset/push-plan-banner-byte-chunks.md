---
"@vibeflow-tools/cli": patch
---

`push` now says which transport it is using, and archive chunks are bounded by size as well as task count.

- The first line of a push reports the split, e.g. `Sending 1788 task(s) in 9 archives` or `Sending 1788 task(s) in 18 batches — legacy path, up to 100 tasks and 50 files per request`. Previously the archive path printed nothing per chunk and the legacy path printed a counter, so falling back to the slower transport was invisible — 1800 tasks crawling in 100-task steps looked like normal behaviour.
- When the archive path is unavailable the CLI now says so before starting (`Archive upload is unavailable on this server` / `…needs the board id`), instead of silently switching transports.
- Archive chunks are capped at 10 MiB of input bytes in addition to 200 tasks, so a chunk full of screenshots cannot build an arbitrarily large request. A single oversized task still ships alone rather than being split or refused.
