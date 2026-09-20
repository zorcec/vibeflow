---
"@vibeflow-tools/cli": patch
---

Make the published CLI build deterministic by clearing `dist/` before emitting. `clean` is disabled for every tsup target (it has to be, because two targets share `dist/client`), so chunks from previous builds — older content hashes — were never removed and could accumulate in the shipped package. The build now removes `dist/` at the start of the pipeline, so each build emits exactly the chunks its source produces. The intentional layout is unchanged: every runtime chunk still appears once in `dist/` and once in `dist/cli/`.
