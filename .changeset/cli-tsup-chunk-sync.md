---
"@vibeflow-tools/cli": patch
---

The CLI build now syncs every emitted chunk into `dist` and fails loudly if any is missing.

`tsup`'s onSuccess hook copies the code-split chunks the packaged entry
(`dist/index.js`) loads. That copy step was a hand-maintained regex allowlist, and
forgetting to extend it when a new dynamic import was added shipped a broken package:
`verify-attestation` was emitted but never synced, so every `vibeflow tasks --edit`
crashed with `ERR_MODULE_NOT_FOUND`. The build succeeded and the unit suite stayed
green, because the tests import from `src/`, not from `dist/`.

The allowlist is replaced by a glob that copies every emitted `.js` module, and the
build now asserts that every relative import in the packaged entry resolves on disk,
so a broken `dist` can no longer be produced. A regression test
(`tests/e2e/tsup-chunk-sync.test.ts`) asserts the same invariant against the built
output.
