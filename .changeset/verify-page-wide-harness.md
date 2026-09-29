---
"@vibeflow-tools/cli": patch
---

Give `verify`'s page-wide path a test that actually runs, and delete the skipped twin that hid it.

`tests/e2e/verify-page-wide.test.ts` was `describe.skip`'d and had never executed a
single assertion: it used CJS `__dirname` under ESM, so it could not even be collected,
and its `beforeAll` execSync'd the never-exiting `kanban` server on a hardcoded port
before `lsof`-killing it. It also asserted against a task id nothing generates
(`E_NOT_FOUND`), a task with no url and no selector (`E_NO_URL` / `E_NO_BASELINE`),
and `JSON.parse`d `verify`'s stdout — which begins with the human `printResult` banner,
so the parse could never have worked. That file is deleted, not left skipped: a skipped
spec inside a green run is what let the gap go unnoticed.

`tests/playwright/verify-page-wide.test.ts` replaces it with a harness that runs against
a real board and a real chromium: a task created through the CLI (keeping the id the CLI
really generated), annotated with a url and selector, baselined by capturing both the
element and the page-wide snapshot in a browser and POSTing them to the server's own
`/baseline` and `/baseline-page` endpoints. The assertions are on the evidence a real
run produces — `verify-all-styles.json` with the card's back-filled baseline, the
`verify-page-diff.json` that is only written when a page baseline exists, a real PNG
screenshot — plus the page-wide query tools (`html_query` text/children/attributes,
`style_query`, `style_diff`, `element_info`) run over that evidence. Both URL-resolution
branches are covered: a relative `task.url` resolved through the project config's port,
and an absolute one used verbatim, proven by pointing it at a path the board does not
serve and watching the selector stop resolving.

Test-only change: no runtime behaviour, no CLI output, no new dependency.
