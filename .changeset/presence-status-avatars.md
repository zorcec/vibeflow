---
"@vibeflow-tools/ui": patch
---

Co-presence moves into the status row as initials avatars

The detail panel no longer spells out "Ana is in description · Ben is in activity" in a text line above the header. Peers now appear as a compact initials stack inlined with the STATUS row (avatar-stack pattern): each 20px chip shows initials in the peer's own colour (the same colour as their description cursor), the full "name is in area" sentence appears on hover and for screen readers, chips are keyboard-focusable, and crowds collapse to a "+N" chip that names everyone hidden.
