# API v1 contract artifacts (Phase 0)

Zero behaviour change: everything here is additive — a contract, a manifest,
a runner skeleton, a generated registry, and a read-only spec route.

## Source of truth

- **`v1-contract.json`** — hand-authored, reviewed. The single source: every
  v1 operation (method, v1 path, current local handler or null, scope, plan
  §1.2 row), the deliberately-excluded local routes (each with its reason),
  and the non-API carve-outs. Edit this, then regenerate — never the outputs.

## Generated outputs (do not hand-edit)

Produced by `packages/api-core/scripts/gen-api-artifacts.mjs`
(`pnpm --filter @vibeflow-tools/api-core gen:api`, also wired into the CLI
`prebuild` so builds self-heal). A freshness test fails if these differ
from generated output:

- **`openapi.yaml` / `openapi.json`** — the `/api/v1` contract (OpenAPI 3.1)
  as a human doc and its canonical JSON twin. The generator also lints
  (3.1 marker, operation count, operationId + 200 per op, resolvable $refs).
- **`packages/api-core/src/route-registry.gen.ts`** — the typed route
  registry (every v1 op + local-only list + carve-outs).
- **`packages/cli/src/server/openapi.gen.ts`** — byte-exact payload served
  at `GET /api/openapi.json`.

## Runner + manifest

- **`conformance-manifest.json`** — one entry per contract operation with
  the cases each must satisfy on both surfaces. `runnable: local-read`
  entries run in Phase 0; writes and handler-less ops are data until
  Phase 3 and are reported skipped with their target phase.
- **`packages/api-core/src/conformance.ts`** — local-side runner skeleton:
  fail-fast transport (hard timeouts, named errors, never hangs), response
  normalization, explicit skip accounting.
- **`packages/api-core/src/normalize.ts`** — the normalizer (unit-tested):
  strips volatile fields via a per-run id table and FAILS CLOSED on
  unlisted fields. Encodes the D3/D6/cancelled/author resolutions as
  assertions, not prose.

## Guards (plan §6.4, Phase 0 wiring)

Tested in `packages/cli/tests/unit/api-v1/drift-guards.test.ts`:

- **#1 registry ⇄ spec ⇄ handler** — v1 set equality both directions;
  every registry local maps to a scanned handler; every scanned `/api`
  handler is classified (an unregistered route fails).
- **#2 legacy-may-not-re-implement** — no `/api/cli/*` or `/api/v1/*`
  registration in the CLI surface; no new bearer-accepting handler
  (allowlist: `src/mcp/auth.ts`, grandfathered until P1/P2).
- **Coverage** — every registry route has a manifest row and vice versa.
