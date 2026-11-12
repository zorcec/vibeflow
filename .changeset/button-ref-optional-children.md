---
"@vibeflow-tools/ui": patch
---

`Button` forwards its ref and no longer requires children.

The dashboard shell keeps a `RefObject` on its mobile menu button to focus it
when the drawer opens; without `forwardRef` React dropped the ref and the focus
call silently no-oped. The shell also renders an `aria-label`-only backdrop
button, which the required `children` prop forced back to a raw `<button>`.
Both gaps are covered by tests (ref identity + focus, and a labelled button with
no children), each proven to fail before the fix.
