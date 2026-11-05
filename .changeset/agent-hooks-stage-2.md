---
"@vibeflow-tools/cli": minor
---

Agent hooks Stage 2: fail-closed pre-hook gates with bypass audit. Every gated invocation (`tasks --add/--edit/--delete/--next/--comment`, `verify`, `push`, `pull`, plus the matching operation-layer paths) runs its `pre-<event>.mjs` (or `.hook.mjs` module) before the write with an intent payload — fields known before effects, never generated ids. The full task snapshot is immutable and agent instructions are the only replaceable surface. Timeout, non-zero exit, non-JSON output, malformed decisions, and explicit `{allow:false,reason}` all block with the existing refusal shape and a non-zero exit. `--no-verify` skips the gate loudly (HOOK_BYPASSED notice plus a local append-only audit record; after-hooks still run), and an untrusted project pre-hook blocks while an untrusted after-hook only skips. Public authoring types gain the pre envelope/handler/result (`@vibeflow-tools/cli/hooks`).
