---
"@vibeflow-tools/shared": minor
"@vibeflow-tools/ui": minor
---

Task descriptions now have one length limit instead of three, and the limit is
visible before it is hit.

`TASK_DESCRIPTION_MAX = 20_000` is exported from `@vibeflow-tools/shared` and used
by every schema that accepts a description. The overlay API previously capped at
5,000 while the web form capped at 10,000 and Postgres (`text`) capped at nothing
— so a description accepted by the form was silently refused by the bookmarklet,
and anything over 10,000 produced a bare `400 Bad Request` with no field, no
limit and no explanation.

`MarkdownEditableField` gained an optional `charLimit`: it sets `maxLength` so an
over-limit submit is impossible by typing or pasting, and renders a
`N / limit` counter **only near the cap** (revealed in the last 2,000 characters,
amber in the last 500). Fields without a cap, such as comments, are unchanged.
