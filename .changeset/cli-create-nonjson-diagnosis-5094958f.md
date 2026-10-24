---
"@vibeflow-tools/cli": patch
---

`tasks --add` against the remote board now names the HTTP status, path, and response head when the create fails without a backend code. A proxy 502 HTML page (or an empty/truncated body) used to collapse into the same bare creation failure as a dead host; the failing call now prints e.g. `HTTP 502 /api/v0/tasks — response head: …`. True transport failures keep the old message and hint.
