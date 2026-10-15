---
"@vibeflow-tools/ui": patch
---

Done lane fits its `+N more` overflow chip without clipping it. The fit count now reserves the chip's real height (44px) plus its flex gap and the scroll container's bottom padding (57px total) instead of 29px, so at short viewport heights the chip no longer sticks past the lane's hidden-overflow container and gets cut off. No drag, hover, or drop behaviour changed.
