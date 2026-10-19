---
"@vibeflow-tools/cli": patch
---

Agent chat overlay surface (ticket 0847833f, behind
`VIBEFLOW_FEATURES=CHAT`, default OFF). New overlay chat dock: trigger
button, session lifecycle, WS-mapped streaming/tool cards, approval
cards wired to the server gate, read_dom browser round-trips, trusted
page metadata on send, and pasted-image downscale via the shared matrix.
`PROTO_CONFIG.agentChat` gates the bundle (hosted builds always false);
chat routes register in both serve modes with cleanup on shutdown.
Includes Playwright coverage (panel open/close, flag-off zero surface)
and a record/replay cassette harness for the pi wire protocol.
