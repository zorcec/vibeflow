"@vibeflow-tools/cli": minor
---

`vibeflow verify --pixels` captures the task selector region as baseline/after PNG evidence (`verify-baseline-pixels.png`, `verify-after-pixels.png`) and diffs them per channel: the output carries a greppable `PIXEL_DELTA=<max>/255 (<pct>% of pixels changed)` line and `--json` carries `pixelDelta: {max, pct, sameSize}`. Size drift is reported (`sameSize: false`), never diffed. `--min-pixel-delta <n>` (0-255, default 0 = report only) demands a visible change and fails `ok` when unmet. First run bootstraps the baseline; pixel PNGs stay raw (true `.png`, decoded with the repo's dependency-free PNG codec — no transcode, no new deps).
