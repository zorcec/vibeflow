---
"@vibeflow-tools/ui": patch
---

Task cards no longer jump on hover. The `:hover` rule lifted the card 1px with `translateY(-1px)`; hover feedback is now border + background + shadow only, so the card's box is identical before and during hover (measured delta 0).
