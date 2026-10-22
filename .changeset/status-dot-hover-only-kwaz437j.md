---
"@vibeflow-tools/ui": patch
---

Status dot tooltip claim (ticket kwaz437j, R11): the dot's `title` is hover-only — no browser opens it on keyboard focus — so the old `tabIndex={0}` promised a keyboard tooltip the code could not deliver while adding a tab stop with no behaviour. The dot is no longer focusable; keyboard and screen-reader users lose nothing because the status name was and stays in the accessible name (`role="img"` + `aria-label`). Docstrings and tests now state the hover-only contract honestly.
