---
"@vibeflow-tools/cli": patch
---

Fix high- and moderate-severity advisories in shipped and build dependencies,
and remove a dependency override block that had never worked.

`cheerio` resolves `undici` to 7.29.0, one patch below the 7.29.1 that fixes
GHSA-w293-vg96-wgc3. `undici` is a runtime dependency, so this shipped to
users.

The root `package.json` carried an `overrides` block with floors for ten
packages. pnpm v11 ignores that block entirely — every one of the ten was
inert, verified empirically by removing the block and reinstalling: not one of
563 resolved versions moved. Two of them were contradicted by their own
resolution (`encoding-sniffer` resolved 0.2.1 against a stated floor of
`^1.0.2`; `qs` resolved 6.15.1 against `>=6.15.2`), so they read as security
controls while enforcing nothing. The block is deleted.

Floors that still had a live advisory to clear now live in
`pnpm-workspace.yaml`, where pnpm actually reads them:

- `undici` >=7.29.1, `brace-expansion` above 2.1.6 and 5.0.11
- `qs` >=6.16.0, `ip-address` >=10.7.1, `hono` >=4.13.7 — all three reached
  the published CLI as runtime dependencies via `@modelcontextprotocol/sdk`
- `esbuild` >=0.28.1, build-time only

`pnpm audit --audit-level=high` and `pnpm audit --prod --audit-level=high`
both exit 0. High-severity findings go from 6 to 0; production advisories
from 5 to 0.

Two moderate advisories remain, deliberately: `vitest` and `@vitest/mocker`
below 4.1.11, reachable only through `@stryker-mutator/vitest-runner`. They
are dev-only and affect opt-in mutation testing. Clearing them requires a
vitest 3 to 4 bump across the workspace, which is too large to carry in a
security patch. A scoped override was tried and reverted — `vitest` is a peer
dependency of the Stryker runner, so the override installed nothing and left
an unmet peer, which is worse than the advisory it targeted.