---
"@vibeflow-tools/ui": patch
---

Add optional `onDownload`/`onFileDownload` download handlers to `FileItem`, `FilesList`, `CommentsList`, and `DetailPanel`. A bare `<a href download>` cannot send the `X-Vibeflow-Scope` header, so scoped file downloads failed closed; callers can now fetch with scope headers and trigger the save themselves. Behaviour is unchanged when the handler is absent.
