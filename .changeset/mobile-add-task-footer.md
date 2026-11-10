"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

The Add Task / Cancel footer no longer disappears on real phones. Two compounding causes, neither visible in desktop device emulation: `100vh` sizing resolves against the large viewport, so with the URL bar visible the panel extended below the fold and its footer hid behind the browser chrome — `100dvh` (with `vh` fallback) now tracks the visible height; and the shell viewport meta carries `interactive-widget=resizes-content`, so the on-screen keyboard shrinks the layout instead of covering the footer. The narrow-viewport footer also drops the 360px panel floor, wraps instead of clipping, clears the home indicator, and grows to a 36px touch target.
