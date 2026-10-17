---
"@vibeflow-tools/cli": minor
---

Minimal push output with ETA (e4049164): the bulk-push reporter now keeps a TTY to one updating line (counter + bar + percent + ETA from start-time × completed-rate, `--:--` until measurable) and piped output to sparse lines (one per 10% of total, or one per 10s on slow pushes, plus the final N/N) instead of one line per task, and the final summary merges the TRUE created/refused groups and the stop/not-attempted counts into two lines with every dec52322 number intact, all still on stderr with --verbose/--json detail unchanged. Stays on current deps: the ETA is plain rate arithmetic.
