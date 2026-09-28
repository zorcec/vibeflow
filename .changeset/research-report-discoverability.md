---
"@vibeflow-tools/cli": patch
---

A `RESEARCH_REPORT_REQUIRED` refusal now names the MCP recovery path.

The refusal's `suggestion` named only `--report-file ./my-report.md` — a flag no MCP client
has, so a client told to "pass a .md report" was given an instruction it could not follow.
It now names both routes: `attach_file` with a `.md` filename (MCP) and `--report-file`
(CLI), since the same gate serves both surfaces. `RESEARCH_VERIFY_NOT_ALLOWED` names the
same recovery for the same reason.

The `attach_file` tool description — the only documentation an MCP client reads, and what
`tools/list` echoes — now states that a `.md` filename is what satisfies the research-report
gate for a `type:"Research"` task, instead of describing base64 attachment and nothing else.

No behaviour changes: the gate, the flags and the file attachments are all exactly as before.
