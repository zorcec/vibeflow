---
"@vibeflow-tools/ui": minor
"@vibeflow-tools/cli": minor
---

Kanban UI: list view now orders sections todo → in-progress → review → backlog → done; view switches are Board | Compact | List, where Compact renders one-line done-style rows across all lanes (no strikethrough on open lanes); the done lane fits cards to the visible column height with a "+N more" indicator while all other lanes render every card with normal infinite scrolling; the fit-screen calculation is now declarative, eliminating flicker from imperative card hiding. Overlay: the add-task dialog gained a collapsible "Advanced" section with tag chips and a priority selector (Critical/High/Medium/Low); both are optional and forwarded to the task creation API.
