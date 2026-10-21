---
"@vibeflow-tools/cli": patch
---

Fix the release-blocking dead CLI artifact: the built `vibeflow` binary crashed
on every invocation with `Dynamic require of "crypto" is not supported` while
the build itself stayed green.

The ESM bundle inlined a CJS dependency whose bare `require("crypto")` esbuild
can only emit as a runtime-throwing `__require` shim (ESM has no `require`).
`tsup.cli.config.ts` now sets `platform: "node"` explicitly, keeps node
builtins (`node:*`, `crypto`, `fs`, `path`, …) external so the output retains
`import … from "node:crypto"`, and adds the standard
`createRequire(import.meta.url)` banner so any residual CJS `require` of a
builtin resolves at runtime instead of throwing.

Also adds `tests/e2e/cli-bundle-boots.test.ts`: a bootsmoke guard that spawns
the built artifact (`--version`, `pull --help`, `push --help`) and asserts exit
0, so a green build can never again hide a dead artifact. Verified the guard
fails against the pre-fix bundle (3/3 spawn tests red) and passes with the fix.
