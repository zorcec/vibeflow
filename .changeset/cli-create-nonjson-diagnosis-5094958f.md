---
"@vibeflow-tools/cli": patch
---

Online `tasks --add` names the HTTP status, path and response head when the
create fails without a backend code (ticket 5094958f). A proxy 502 HTML page
(or an empty/truncated body) used to collapse into the same bare "Failed to
create task in online board." as a dead host — the status was discarded
wherever the body lacked a code. `createSaasTask` now reads error bodies as
text first (non-JSON answers keep status + path + head instead of a bare
parse failure), a 201 with an unparseable body reports HTTP_ERROR with the
same shape instead of escaping as NETWORK_ERROR, and the generic branch
prints `Failed to create task in online board (HTTP 502 /api/v0/tasks —
response head: …)`. True transport failures keep the old message and hint.
A future occurrence names status, content-type and the first bytes.
