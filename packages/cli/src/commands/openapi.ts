import { OPENAPI_JSON, OPENAPI_YAML } from "../server/openapi.gen.js";

/**
 * `vibeflow openapi` — print the bundled OpenAPI spec to stdout.
 *
 * No server or port is involved: the spec is embedded at build time by
 * packages/api-core/scripts/gen-api-artifacts.mjs (generated from
 * docs/api/v1-contract.json, never hand-maintained), so this is pipeable
 * (`vibeflow openapi > openapi.json`) and usable from codegen / CI /
 * agent harnesses. `--yaml` prints the YAML twin (docs/api/openapi.yaml).
 *
 * Writes the payload with a single stdout write and nothing else — no
 * framing, no colour, no update notice — so the bytes stay pipe-clean.
 */
export function printOpenApi(opts: { yaml?: boolean } = {}): void {
  process.stdout.write(opts.yaml === true ? OPENAPI_YAML : OPENAPI_JSON);
}
