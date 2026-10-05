---
"@vibeflow-tools/cli": patch
---

fix(cli): stop `vibeflow login` opening a browser when nobody is there to use it

`login` shelled out to the `open` package unconditionally, which on Linux means
`xdkg-open` and a real browser tab. In CI, in scripts and in the web e2e suite
that produced surprise tabs at `…/cli/verify?code=…` on the developer's desktop —
tabs nobody asked for, pointing at a throwaway instance. `BROWSER=true` does not
prevent it; `open` ignores `BROWSER` on Linux.

The browser is now opened only when the process has a TTY and
`VIBEFLOW_NO_BROWSER` is not set. The verification URL is printed either way, so
nothing is lost — the flow is fully usable by copy-paste.
