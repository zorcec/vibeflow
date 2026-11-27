---
"@vibeflow-tools/cli": minor
---

**The board's API answers every error in one documented shape: `{ error, code, details? }`.**

A refusal used to put its machine code in the field a person reads (`error`), hide the readable sentence in a second field (`message`), and scatter format hints across `expectedFormat`/`example`. A script therefore had to know which endpoint it was calling before it could tell a user what went wrong — and the same refusal was spelled differently on each one.

Now every error response reads the same way:

- `error` — the sentence to show a person;
- `code` — the machine token a script branches on, e.g. `INVALID_SINCE`, `NOT_FOUND`, `FORBIDDEN`;
- `details` — structured hints (`expectedFormat`, `example`, the offending field) when there are any.

Status codes and success responses are unchanged, and a client that only ever showed the human message keeps working untouched — it reads `error` exactly as before. Nothing was lost in the move: the format hints the notification feed publishes simply moved into `details`.

```json
{
  "error": "`wait` must be a whole number of milliseconds — e.g. wait=20000. Omit it to poll instead of waiting.",
  "code": "INVALID_WAIT",
  "details": { "expectedFormat": "<milliseconds, digits only>", "example": "wait=20000" }
}
```
