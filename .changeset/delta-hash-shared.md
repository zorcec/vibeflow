---
"@vibeflow-tools/shared": minor
---

Add `canonicalJson`, `sha256Hex` and `hashTaskRecord` to the shared package.

The CLI and the web server must serialise a task record identically before comparing
hashes, otherwise every push marks every task as changed (jsonb does not preserve key
order). Keeping one implementation in shared removes that failure mode. `canonicalJson`
is moved verbatim from the private repo's `import-record.ts`, which now re-exports it,
so the existing comparison in the import route is unchanged.
