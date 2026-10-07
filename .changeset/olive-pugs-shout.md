---
"@vibeflow-tools/cli": patch
---

fix(cli): stop the device login flow opening a browser when nobody is there to use it

The login flow shelled out to the `open` package unconditionally, which on Linux means
`xdg-open` and a real browser tab. In CI, in scripts and in automated test runs
that produced surprise tabs at `…/cli/verify?code=…` on the developer's desktop —
tabs nobody asked for, pointing at a throwaway instance. `BROWSER=true` does not
prevent it; `open` ignores `BROWSER` on Linux.

The browser is now opened only when the process has a TTY and
`VIBEFLOW_NO_BROWSER` is not set. The verification URL is printed either way, so
nothing is lost — the flow is fully usable by copy-paste.
