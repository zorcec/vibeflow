---
"@vibeflow-tools/ui": patch
---

**Live updates no longer silently stop after a connection gap.**

`onReconnect` fired only on a *true* reconnect — never on the first connect. A
board opened while the realtime service was unavailable therefore joined
successfully, adopted its join baseline past the events it had missed, and
never resynced: the board looked connected, showed stale cards, and only a
manual refresh reconciled it (bug ed49a72a, condition B).

The handler now fires on **every** successful connect, first one included, so
each connect is a reconciliation point. The extra invalidate is deduplicated
against the mount fetch by react-query. Gap detection, the join protocol and
the transport's retry behaviour are unchanged.
