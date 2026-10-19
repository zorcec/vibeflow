---
"@vibeflow-tools/cli": patch
---

Stop sending captured credentials in the legacy `fields` payload.

The lossless manifest sent a sanitized `record` next to the ORIGINAL record as
`fields`, so `authStateEnc` (captured browser auth state) and the absolute local
`filePath` still left the machine. One sanitized wire record now feeds both
representations, and the sanitizer recurses into arrays nested inside arrays.
