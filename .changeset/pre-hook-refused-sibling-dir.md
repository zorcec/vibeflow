---
"@vibeflow-tools/cli": patch
---

Pre-hook refused-extension gate now checks the right directory: `emitPreHook` passed the bare hooks root to `refusedSibling`, so a `pre-<event>.js`/`.cjs` sitting beside a valid `pre-<event>.mjs` in the `pre/` subdirectory stayed silent instead of warning `HOOK_BAD_EXTENSION` on stderr. It now checks `<root>/pre`, matching the lookup dir (and the after gate's `<root>/after`).
