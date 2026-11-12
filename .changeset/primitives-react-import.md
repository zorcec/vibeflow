---
"@vibeflow-tools/ui": patch
---

Primitives import React explicitly so consumers with the classic JSX transform
can render them.

`button`, `badge`, `input`, `textarea`, `dialog`, `popover`, `tooltip`,
`select` and `tabs` relied on the automatic JSX runtime. A consuming app whose
test/build pipeline uses the classic transform (the private web app's vitest
does) crashed with `ReferenceError: React is not defined` the moment a screen
rendered `<Button>`. Found while migrating the auth screens (P17b.1); the
web unit suite then went from 2 failed to 22 passed.
