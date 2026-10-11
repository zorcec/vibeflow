---
"@vibeflow-tools/ui": patch
---

Remove the fullscreen checkbox from the kanban settings modal

The "Open task details fullscreen" checkbox (`#settings-panel-fullscreen`)
is gone from the settings Board tab, along with its local state and Apply
wiring. The `panelFullscreen` preference itself stays alive: the detail
panel's own maximize/restore control (`#dp-fullscreen-toggle`) still reads
and writes the same persisted flag, `AppSettings.panelFullscreen` is
unchanged, and the settings allowlist still accepts it. The modal's save
payload omits the key, so App.tsx's `{ ...appSettings, ...newSettings }`
merge preserves a previously saved value instead of clobbering it.

- Settings no longer shows a fullscreen checkbox; the detail panel's own toggle remains the single control for the flag.
