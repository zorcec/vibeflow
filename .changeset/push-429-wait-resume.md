---
"@vibeflow-tools/cli": minor
---

Push now rides out rate limits instead of abandoning the remaining tasks: when the server answers 429, the push waits for the advertised `Retry-After` (capped at 120 seconds) and resumes where it stopped, up to 3 waits per push — on both the batch path and the one-by-one fallback. The login-time push also uses the batch import when the server offers it, with the same one-by-one fallback and quota preflight as `push`.
