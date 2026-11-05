---
"@vibeflow-tools/cli": patch
---

Hook authoring ergonomics: shipped default texts are generated as readable line-arrays (delivered bytes unchanged); `console.log/info/warn/debug` is safe in all three hook modes (child-side stderr redirect — stdio preloads `hook-console-guard.mjs` via `node --import`, module/TS get the loader-top patch) so chatter can never become an instruction; and a shipped runtime utility (`readEnvelope()` / `reply()` / `log()`, resolved via the runner-injected `VIBEFLOW_HOOK_RUNTIME` env var or the `@vibeflow-tools/cli/hooks/runtime` subpath) drops the hand-rolled stdin boilerplate.
