---
"@vibeflow-tools/cli": minor
---

Add `get_file` download path (mirror of `attach_file`): MCP `vibeflow_get_file(id, filename|fileId)` returns `{filename, mimeType, size, contentB64}`, and `vibeflow tasks --get-file <id> <name> [--out path]` writes the bytes to disk. Local reads come from the task's files dir; remote mode downloads through the board's file endpoints, so agents can read attachment bytes the stripped file list never carries.
