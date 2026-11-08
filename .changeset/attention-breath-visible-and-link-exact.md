---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Needs-attention: the bell breath is now visible and the amber tint is link-exact only.

- **Breath.** The `attention-breathe` glow was technically animating (the
  computed `filter` varied) but painted a ~5% channel delta around an 11px
  glyph, so owners reported "the breathing animation is still not there" for
  three rounds. The peak now stacks a tight full-alpha amber ring, a wide
  halo and a hotter glyph (`brightness(1.35)` — luminance only, no hue shift),
  measured at 57% of the bell region changing / 48 max channel delta instead
  of 23% / 13. Reduced motion keeps the bell static but now leaves a visible
  amber glow (`filter: none` made the flag indistinguishable from a plain
  glyph).
- **Highlight.** The derived attention row used to guess its reason from the
  newest surviving comment, so the amber flag row (and, before the tint fix,
  the amber card) read as attached to whichever message arrived last — the
  owner's "now it is random". Placement and attribution now come from the
  stored `attentionReasonId` alone; a record with no link is sorted at the
  task's own update time and attributed to the task owner, and tints nothing.

Pinned in the browser on both surfaces: the CLI board Playwright spec
(`kanban-attention-icon.test.ts`) and the hosted e2e spec
(`needs-attention.spec.ts`) screenshot the bell at the breath's peak and
trough and require a real painted difference, then assert exactly one amber
comment — the linked agent message — with newer plain notes untinted and a
cleared link tinting nothing.
