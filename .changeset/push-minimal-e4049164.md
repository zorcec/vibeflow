---
"@vibeflow-tools/cli": minor
---

Push output stays minimal on huge runs: a TTY shows one updating line (counter, bar, percent, ETA) and piped output logs sparsely instead of one line per task. The final summary merges created/refused and stop/not-attempted counts into two lines, all on stderr with `--verbose`/`--json` detail unchanged.
