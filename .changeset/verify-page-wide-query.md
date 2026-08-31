---
"@vibeflow-tools/cli": minor
---

feat(verify): page-wide query system with progressive exploration

Adds page-wide element capture and query tools for agents to explore verify evidence:

- `vibeflow verify style_diff <id>` — summary of all style changes across the page
- `vibeflow verify style_query <id> <prop>` — ALL elements where a property changed
- `vibeflow verify html_query <id> children|text|attributes` — structural changes
- `vibeflow verify element_info <id>` — element details

Captures `verify-all-styles.json` with element tree, styles, and structure for every element with classes or data-attributes.
