---
"@vibeflow-tools/cli": minor
---

Agent hooks Stage 1.5: module-adapter `.hook.mjs` mode plus public authoring types. A hook may now be `after-<event>.hook.mjs` exporting default a function (async OK) that receives the full envelope as its argument; a packaged loader runs it in a child process with the same 2s deadline, trust, and fail-open `{instructions}`/`{}` policy as the stdio `.mjs` mode. Mode is chosen by filename only — both files at one level is a configuration error with no fallback. Authoring types ship as a types-only `@vibeflow-tools/cli/hooks` subpath (after-only envelope union, no runtime API, no TypeScript execution).
