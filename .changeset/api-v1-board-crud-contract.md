"@vibeflow-tools/cli": patch
---

Add board CRUD to the v1 contract (P3-A cutover): `list-boards` / `get-board` / `create-board` / `patch-board` / `delete-board` operations (cloud-only, no local handler) with new `boards:read` / `boards:write` scopes in the vocabulary, PAT read-only/read-write presets, regenerated spec, registry, and manifest rows. No existing endpoint changed.
