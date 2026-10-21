---
"@vibeflow-tools/shared": minor
---

`delta-hash` is no longer re-exported from the package barrel; import it from
`@vibeflow-tools/shared/delta-hash`.

The barrel re-export broke the CLI release build outright: `delta-hash` imports
`node:crypto`, so any consumer touching the index pulled it in — including the
CLI's browser-target overlay bundle, whose esbuild pass failed with
`Could not resolve "node:crypto"`. `node scripts/build-atomic.mjs` could not
complete, which means `vibeflow` could not be built or published at all.

The subpath export was always the supported entry point; the barrel re-export was
added later and reintroduced exactly the bundler hazard the subpath exists to
avoid. Keeping it out of the barrel makes the failure impossible to reintroduce
by accident.
