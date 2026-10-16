---
"@vibeflow-tools/cli": patch
---

Stop shipping the CLI runtime twice: `dist/cli/` (3.80 MB) carried byte-identical copies of every chunk already present at `dist/` root, pushing the unpacked tarball to 9.31 MB — over the 8.00 MB publish budget (ticket 380c7ff7). The `files` list now ships `dist/*.js` instead of the stale per-chunk allowlist plus the whole `dist/cli/` directory, and `bin` + the Glama container ENTRYPOINT/probe point at the single `dist/index.js` entry (byte-identical to the old `dist/cli/index.js`; the build still emits both on disk). Unpacked tarball drops to ~5.5 MB with no budget change. Side benefit: the `.` library export's lazy chunks (`git-*`, `review-gate-*`, `verify-attestation-*`, …) now actually ship, instead of resolving only from `dist/cli/`.
