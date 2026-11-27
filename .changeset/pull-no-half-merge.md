---
"@vibeflow-tools/cli": patch
---

**`vibeflow pull` can no longer leave a half-applied local store.**

A pull that hit an I/O error partway through its merge — a full disk, a
permissions change, the process being killed — could stop between two files,
leaving some tasks updated and the rest untouched. The write phase now records
an undo journal before it touches the store: a failed write rolls every write
back and says so in the error, and a journal left behind by a killed run is
undone by the next pull before it plans anything. A pull is either fully
applied or fully unchanged.
