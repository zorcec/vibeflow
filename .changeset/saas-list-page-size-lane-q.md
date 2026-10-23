---
"@vibeflow-tools/cli": patch
---

Online listing requests the 500-row v0 page ceiling (LANE Q step 1). `fetchSaasTasks` now sends `limit=500` on every list page (verified server max: the v0 list answers 400 above 500 and defaults to 100 without the param) while cursor-following is unchanged. A 1,874-task board costs 4 list requests instead of 19 with identical rows in identical order; servers that ignore the param answer default pages and still read to completion.
