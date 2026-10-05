---
"@vibeflow-tools/ui": patch
---

fix(ui): stop rendering a JSX source comment as visible text in the task detail panel

Two lines of developer commentary sat as the first children of the fragment
`DetailPanel` returns. Inside JSX, `//` is not a comment — an element's children
are text — so both lines were painted as literal copy above the panel header.

The note now sits above the `return` where it belongs, and a regression test
asserts the panel renders no text node that looks like a source comment.

The test scans the whole render output rather than `#detail-panel`: the leaked
text renders as a sibling *before* the `<aside>`, so a guard scoped to the panel
passes with the bug still present.