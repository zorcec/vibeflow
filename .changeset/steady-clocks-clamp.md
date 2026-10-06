---
"@vibeflow-tools/cli": patch
---

fix(cli): clamp auth-state age at 0 so clock jitter can't render "-1m"

`listAuthStateFiles` computed `ageMs = Date.now() - stat.mtimeMs` and floored it
per unit. When an auth-state file's mtime sat even 1 ms ahead of `Date.now()`
(NTP settling after reboot), `Math.floor(-0.000016)` became `-1` and the age
string rendered as `"-1m"`, failing the `\d+[mhd]` format and tripping
`tests/unit/commands/auth.test.ts > reports age correctly` intermittently in the
pre-push hook. The age is now clamped at the source — `Math.max(0, ...)` — so
the minutes, hours and days branches all derive from a non-negative delta and an
age can never go below `0m`. Regression test seeds an auth-state file with an
mtime 5 s in the future and asserts `age === "0m"`.
