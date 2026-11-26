---
"@vibeflow-tools/cli": patch
---

`tasks --edit <id> --set-status review --report-file report.md` now works on the hosted board.

It answered `Task not found` for a task that plainly existed, because the flag was written for the local store in two places: the precondition probe read the **local** task list even after the id had already been resolved through the online detail request, and the upload wrote to the **local** file store — which on the hosted board would have put the report beside a task the board does not own. So the documented Research submission (report + review in one command) could not be performed online at all; agents had to attach the report with `tasks --attach` and then transition separately.

The probe now reuses the task the resolver already returned, and the upload goes through the same shared operation `tasks --attach` uses, so the local store and the v0 upload cannot diverge again. Local mode behaves exactly as before: the report replaces any previous one and the source file is consumed.
