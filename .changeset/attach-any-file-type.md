---
"@vibeflow-tools/cli": patch
---

Task file attachments no longer gate on file type: any file — including `.har` network captures, audio, XML, shell scripts, and extensionless names — now attaches via `attach_file`, the local board upload route, and the review report path. The only remaining refusal is a narrow executable deny-list (`.exe`/`.dll`/`.ps1` and siblings, matching the remote files route) as a malware-droppoint precaution; zip an executable first and the archive attaches. Name sanitisation (no traversal, hidden files, or control characters) and the 50 MB size limit are unchanged.
