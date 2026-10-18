---
"@vibeflow-tools/cli": patch
---

Bulk push paces chunk POSTs with a 5s breather between chunks (ticket 7fa3ef3b), so back-to-back 100-task batch inserts and their broadcasts don't saturate the small server and disturb other users. Skipped before the first chunk and on 429-resume re-POSTs (which already waited). Override with `pacingDelayMs` (`0` disables).
