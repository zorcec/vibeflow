---
"@vibeflow-tools/cli": patch
---

Fix `tasks --edit --set-verify` being silently dropped in SaaS (online) mode

### Highlights

- SaaS edits now send the verification verdict (`verified: true/false/null`)

The `editMode === "saas"` branch built its PATCH from status/title/description/branchName only and never read `--set-verify`, so an attestation submitted in online mode reported success while nothing was stored. The PATCH now carries the same tri-state mapping the local path uses (pass → `true`, fail → `false`, cannot/claim → `null`), the `--dry-run` preview shows it, and a `cannot` reason is recorded as a SaaS comment (mirroring the local system-comment) with the caller told plainly it landed as a comment, not a field.
