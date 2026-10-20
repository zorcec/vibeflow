---
"@vibeflow-tools/cli": minor
---

Make a re-push a repair, and refuse destructive pruning.

- `push` now probes the import capability BEFORE filtering the diff and sends
  tasks that are already on the board when the server advertises `lossless`. A
  re-push is therefore the only thing that can restore comments, commits, links
  and `openedBy` an older lossy import dropped — previously "Everything is
  already pushed" returned first and the repair never ran.
- Quota preflight counts only tasks that will be CREATED.
- `--prune-local` refuses to delete anything unless the server proved a
  lossless import; on a lossy server the local store is the only complete copy.
- `authors link` only asks git about hex-shaped shas: `--all` used to be read as
  an option and "resolved" to a real author email that was then written into a
  task file. It also exits 1 when git is unavailable instead of succeeding.
- `push --json` reports the number of tasks pushed, not the number pruned.
