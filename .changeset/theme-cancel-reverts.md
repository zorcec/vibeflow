---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Cancel in the kanban Settings modal now undoes a theme changed on the Theme tab instead of leaving it applied. Selecting a theme applies a live preview only; Apply commits it, while Cancel, the X, Escape and the backdrop rewind both the applied theme and the stored preference to the value the modal opened with. The shared `SettingsModal` stays appearance-agnostic: its `appearance` slot may now be a render function that receives a per-open lifecycle handle, which is how the CLI's theme switcher takes part in Apply and Cancel. Choosing "System" reverts to whatever was stored before, including clearing the key again.
