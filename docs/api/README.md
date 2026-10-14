# API v1 contract artifacts (Phase 1)

Zero behaviour change to existing routes: Phase 0 added the contract,
manifest, runner skeleton, generated registry and read-only spec route;
Phase 1 adds the identity/scope layer, a local `/api/v1` read alias that
delegates to the existing handlers, and the `/api/docs` viewer.

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
  Phase 3 and are reported skipped with their target phase. `surfaces`
  names the surfaces an entry executes on: the cloud run executes every
  `"cloud"` entry against the v1 paths and reports the rest skipped by
  name with `cloudSkipReason` (local-only ops, P4 MCP).
- **`packages/api-core/src/conformance.ts`** — per-surface runner:
  `runConformance(entries, transport, { surface })` (`local` default,
  bit-identical to Phase 0; `cloud` translates case paths to the v1 base).
  Fail-fast transport (hard timeouts, named errors, never hangs), response
  normalization, explicit skip accounting.
- **`packages/api-core/src/normalize.ts`** — the normalizer (unit-tested):
  strips volatile fields via a per-run id table and FAILS CLOSED on
  unlisted fields. Encodes the D3/D6/cancelled/author resolutions as
  assertions, not prose.

## Phase 1: principal + scope, read alias, docs viewer

- **`packages/api-core/src/{scope,principal}.ts`** — the scope vocabulary
  (`ScopeName`, `ALL_SCOPES`), the `Principal`/`ScopeRef` shape and the
  `requireScope` gate (403), plus the local trusted principal and the
  pure `X-Vibeflow-Scope` / bearer header parsers the cloud adapter (P2)
  builds on. Exported from `@vibeflow-tools/api-core`.
- **`/api/v1` read alias** (`packages/cli/src/server/v1.ts`) — the nine
  `runnable: local-read` operations as GET routes that gate on their
  contract scope and rewrite to the legacy path, so the ONE existing
  handler serves. Anything else under `/api/v1/*` is a JSON 404 (reads
  only; writes land in Phase 3). Rollback is removing the mount call.
- **`/api/docs`** (`packages/cli/src/server/docs.ts`) — Swagger UI page
  rendering `/api/openapi.json`, assets vendored via
  `scripts/embed-swagger-ui.mjs` into `swagger-ui.gen.ts` (no CDN).
  Never auto-injects a credential; “Try it out” sends only a pasted token.

## Guards (plan §6.4, Phase 1 wiring)

Tested in `packages/cli/tests/unit/api-v1/drift-guards.test.ts`:

- **#1 registry ⇄ spec ⇄ handler** — v1 set equality both directions;
  every registry local maps to a scanned handler; every scanned `/api`
  handler is classified (an unregistered route fails); every scanned
  `/api/v1/*` handler matches exactly one registry op, and every mounted
  read op has exactly one handler (one handler per resource).
- **#2 no-second-implementation** — no `/api/cli/*` registration anywhere;
  `/api/v1/*` registrations live only in `src/server/v1.ts`, which imports
  no `core/*` store module (statically asserted); no new
  bearer-accepting handler (allowlist: `src/mcp/auth.ts`).
- **#3 one parity suite, executed twice** —
  `v1-parity.test.ts` fetches every read from the legacy path and the v1
  path and asserts byte-identical bodies.
- **Coverage** — every registry route has a manifest row and vice versa.
