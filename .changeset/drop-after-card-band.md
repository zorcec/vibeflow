---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

Make "drop after this card" reachable again on the Kanban board.

While a drag is active every childless card renders the dashed **Drop to add as
first child** slot inside its `<article>`, and `classifyForDropIntent` measured
that whole article. The article rect therefore included the slot, which pushed
the 'after' band off the card and onto the slot itself: the bottom band began
*below* the card content, so aiming at the lower part of a hovered card always
resolved to make-child. Measured on a real board, a card's article spanned
250–334px with the 'after' band starting at y>302 — while the slot occupied
305–329. There was no 'drop after' gesture to aim at; the only reachable
outcomes were "before" (top band) and "make child".

Classification now runs against the card's **content** rect — the article minus
the drop slot — so the bands stay on the card: the top band, the centre
make-child zone and the bottom 'after' band are all reachable, including on
short cards. A cursor on the slot itself stays centre/make-child, which is what
the slot is for. A drag with no slot rendered classifies exactly as before, and
the make-child pill keeps its existing behaviour (only a cursor that has left
the card pins to centre).

Fixes the classification only — the slot still occupies layout while a drag is
active, so cards below the drag source still shift down slightly. Covered by
`classify-for-drop-intent.test.ts`, a `KanbanBoard.dnd` case that drives a real
drop with the slot mounted, and a new `dnd-all-surfaces` "Surface 5" browser
test that drags onto a card's bottom band and asserts a reorder (it linked a
parent before this fix).
