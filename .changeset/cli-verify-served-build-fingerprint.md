---
"@vibeflow-tools/cli": patch
---

### Highlights

- ✨ `vibeflow verify` now records WHICH build it measured: a served-build fingerprint (sha256 of the served page's inlined bundle + CSS, or its content-hashed asset URLs, plus its version stamp) is printed next to the evidence paths and stored in `verify-after.json` / `baseline.json` / the `--json` result. A board still serving an old bundle no longer looks exactly like a board serving the build under test.

`verify` could return clean, green evidence against a page that was real, whose selectors resolved, but that ran a bundle built before the change under test — the evidence said "the feature works" when what it had measured was the old build. Verify now fingerprints the build it measured and warns loudly when the baseline evidence and the current run measured two different builds (a rebuild in between), because the diff then compares code against different code and "unchanged" proves nothing. The fingerprint is evidence only: it never changes `ok`, the verdict, or the `--set-verify pass|fail|cannot` attestation, and a page that exposes no build identity reports "cannot compare" instead of guessing.
