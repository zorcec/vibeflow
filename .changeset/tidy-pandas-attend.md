---
"@vibeflow-tools/ui": patch
---

Focus the new-task panel's title input on open. The description editor's mount autofocus used to win the race for initial focus (it fires before the title's deferred focus, which then backs off seeing focus already in-panel), so typing landed in the description instead of the title. The description now autofocuses only for existing tasks; the title focus also uses preventScroll to avoid focus-scroll jank.
