---
"@vibeflow-tools/cli": patch
---

Make the board usable on a phone.

Measured with Playwright at 390x844 and 360x640, then fixed:

- Fields are 16px on phones. iOS Safari zooms the page in when a focused field's
  font-size is under 16px and never zooms back out, so tapping the search box left
  the board zoomed into a clipped layout.
- Long task titles clamp to two lines instead of being cut mid-word at ~184px while
  the row left a wide empty gutter.
- The board name and the "N open · N in progress · N in review" line truncate to one
  line each, so the header no longer pushes the first task halfway down a 360x640
  screen.
- Filter chips, the activity counter, the Tags/User/Type triggers, the view toggles
  and the "Boards" breadcrumb are thumb-sized (44px) instead of 16-26px.
- The invisible lane-advance button on a card no longer accepts taps on touch
  devices: it was `opacity: 0` with no `pointer-events: none`, so a tap on an
  invisible control silently moved a task to the next status.
- The phone board menu closes when you pick an item, instead of leaving Settings
  layered on top of a still-open menu.
- The "Send comment?" prompt wraps its three buttons, which used to overflow a
  360px screen with no way to scroll.
- The activity feed has its own element ids; it shared `#detail-panel-container`
  with the task panel, so lookups were ambiguous and the feed could cover the task.
