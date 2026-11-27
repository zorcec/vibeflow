---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

**Opening another task no longer shows the previous task's attachments.**

The details panel had no out-of-order guard on its attachment fetch. Open a task,
switch to another before the first response lands (a slow connection, a long file
list) and the late response painted the first task's file list, screenshot and
count onto the one in front of you. Each loader now tags its own request and drops
a response a newer request has superseded.
