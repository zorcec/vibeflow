---
"@vibeflow-tools/ui": patch
---

Detail-panel screenshot preview now follows the live files channel. A file add/remove while the panel sits on the details tab used to refresh only the files badge count, leaving the screenshot preview stale until the files tab was opened; the panel now reloads the files list on every file broadcast, on any tab.
