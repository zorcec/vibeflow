---
"@vibeflow-tools/cli": patch
---

**Annotations on a customer page no longer vanish silently.**

`submitTask` posted the create request with a content type and nothing else,
while every other overlay call (list, done, delete, baseline) sends
`X-Overlay-Api-Key`. On a foreign origin there is no session cookie, so the key
is the only credential the route accepts — it answered **401** and the popover
closed as if saved, discarding the annotation without a trace.

The create now uses the same `mutationHeaders()` helper as PATCH/DELETE, so an
embedded overlay can create tasks again. Reproduced against the local stack with
a real board and key (`POST … 401 {"error":"Unauthorized"}` → task missing), and
covered by `tests/unit/client/overlay-submit-headers.test.ts` (create sends the
key when configured, none when not).
