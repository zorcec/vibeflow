<!-- markdownlint-disable MD041 -->
---
"@vibeflow-tools/cli": patch
---

Phone board: status-filter chips removed, remaining filters centred.

Owner annotations from the live board (tickets bx90tjzo / bzn2w18w):

- The All / Todo / In progress / Review / Done chips row
  (`[data-testid="filter-bar"] > .kb-status-filters`) is removed at phone
  widths. It cost a full band above the cards while the single-lane board
  already names the active lane in its header.
- The Tags / User / Type trigger row that remains is centred instead of
  left-flushed, which read as clipped at 360px.

Desktop (≥768px) is unchanged: the chips are still shown and the bar keeps its
left-aligned layout.
