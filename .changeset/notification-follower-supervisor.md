---
"@vibeflow-tools/cli": patch
---

A notification follower that dies is restarted, and a quiet death is no longer silent.

After a long idle the feed could stop for the rest of a session without a word. The extension starts the follower once and never again: when the process exits it only forgot about it, and it reported nothing for a **clean** exit — which is exactly what the follower's own graceful paths produce (a hang-up, a closed pipe, a vanished parent). So a stopped feed looked identical to a quiet board.

The extension now supervises it: any exit is reported once, a restart follows with a bounded backoff (1 s up to 60 s, then it stops trying and says so), and — the part that matters for not losing events — a restart **resumes from the last event actually delivered** instead of from now, so what was published during the gap is not skipped.
