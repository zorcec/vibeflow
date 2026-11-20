---
"@vibeflow-tools/cli": patch
---

Make the board usable on a phone: one lane at a time (MOBILE-KANBAN M1).

At <=767px the board now mounts only the active lane and the lane pills live
in the sticky header as the primary toggle — tap a pill to swap which single
lane renders (all of its cards render up front, no virtualization). The board
no longer scrolls sideways on a phone: the lane floor yields to the viewport
inside the shared narrow block (the ADR-0002 phone carve-out), and the custom
strip scrollbar hides because there is nothing to scroll. The view toggle is
gone at <=767px — kanban is the only phone view, list and compact are
removed, and a stale session override can no longer select them. Card
design, the full-screen task detail, and the existing move/status controls
are untouched; >=768px renders exactly as before.

The hosted app picks the same behaviour up through `@vibeflow-tools/ui`.
