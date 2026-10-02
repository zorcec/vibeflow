---
"@vibeflow-tools/cli": patch
---

Fix high-severity advisories in shipped and build dependencies.

`cheerio` resolves `undici` to 7.29.0, one patch below the 7.29.1 that fixes
GHSA-w293-vg96-wgc3. `undici` is a runtime dependency, so this shipped to
users. The root `package.json` carried an `"undici": ">=7.29.0"` floor that
appeared to cover this, but pnpm v11 ignores that block entirely — the
resolution stayed at 7.29.0 with the floor in place. The floors now live in
`pnpm-workspace.yaml`, where pnpm actually reads them.

Also pins `brace-expansion` above the patched releases (GHSA-1240107,
GHSA-1240111) on the 5.x line, and above 2.1.6 (GHSA-1240105, GHSA-1240109)
on the 2.x line reached via `glob > minimatch@9`. That second chain is
dev-only but kept `publish-cli.sh`'s `pnpm audit --audit-level=high` gate red,
which would have required `--skip-security-audit` on the next release.

Both `pnpm audit --audit-level=high` and `pnpm audit --prod --audit-level=high`
now exit 0; high-severity findings go from 6 to 0.