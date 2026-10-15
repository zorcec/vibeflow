#!/usr/bin/env bash
# Pre-publish gate for the Glama local-mode (stdio) MCP container image.
#
# Builds the image FROM SOURCE (never `npm install @vibeflow-tools/cli@<ver>`:
# at gate time the version under test is not on npm yet) and drives it over
# stdio JSON-RPC, asserting:
#   1. a valid `initialize` response,
#   2. a NON-EMPTY `tools/list`,
#   3. `serverInfo.version` EQUAL to packages/cli/package.json (a stale image
#      fails, it never passes quietly),
#   4. no token/secret in the image (env + layer history scanned for the known
#      variable names),
#   5. non-vacuity: the same handshake against an EMPTY project dir MUST fail
#      with the "not a vibeflow project" refusal — proving this check can
#      actually catch the broken-image shape (missing .vibeflow/ sample).
#
# Exit non-zero on ANY failure and print a single readable PASS/FAIL summary.
# Standalone: bash scripts/check-docker-image.sh  (run from the repo root).
# Env overrides: IMAGE_TAG (default vibeflow-mcp-check:local), KEEP_IMAGE=1
# to skip the final `docker rmi` (default removes the checked image).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-vibeflow-mcp-check:local}"
KEEP_IMAGE="${KEEP_IMAGE:-0}"

failures=0
note()  { printf '%s\n' "$*"; }
fail()  { printf 'FAIL: %s\n' "$*"; failures=$((failures + 1)); }
pass()  { printf 'ok: %s\n' "$*"; }

EXPECTED_VERSION="$(node -e "const p=require('${REPO_ROOT}/packages/cli/package.json'); process.stdout.write(p.version)")"
note "==> check-docker-image: tag=${IMAGE_TAG} expected_version=${EXPECTED_VERSION}"

BUILD_START="$(date +%s)"
note "==> [1/5] docker build (no cache) ..."
if ! docker build --no-cache -t "${IMAGE_TAG}" -f "${REPO_ROOT}/Dockerfile" "${REPO_ROOT}"; then
  fail "docker build failed"
  printf 'RESULT: FAIL (%d failure(s))\n' "$failures"
  exit 1
fi
BUILD_END="$(date +%s)"
pass "docker build succeeded in $((BUILD_END - BUILD_START))s"

IMAGE_SIZE="$(docker images "${IMAGE_TAG}" --format '{{.Size}}')"
note "      image size: ${IMAGE_SIZE}"

# ── stdio handshake against the baked /project sample ─────────────────────────
note "==> [2/5] stdio handshake (initialize + tools/list) ..."
HANDSHAKE_OUT="$(mktemp)"
HANDSHAKE_ERR="$(mktemp)"
trap 'rm -f "$HANDSHAKE_OUT" "$HANDSHAKE_ERR"' EXIT
{
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check-docker-image","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
} | timeout 120 docker run --rm -i "${IMAGE_TAG}" >"$HANDSHAKE_OUT" 2>"$HANDSHAKE_ERR" || {
  fail "container did not answer the stdio handshake (exit $?). stderr:"
  sed 's/^/      /' "$HANDSHAKE_ERR"
}

HANDSHAKE_JSON="$(node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
  let init = null, tools = null;
  for (const l of lines) {
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id === 1 && m.result) init = m.result;
    if (m.id === 2 && m.result) tools = m.result;
  }
  process.stdout.write(JSON.stringify({ init, tools }));
' "$HANDSHAKE_OUT")"

INIT_VERSION="$(printf '%s' "$HANDSHAKE_JSON" | node -e 'const fs=require("node:fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(d.init?.serverInfo?.version ?? "")')"
TOOLS_COUNT="$(printf '%s' "$HANDSHAKE_JSON" | node -e 'const fs=require("node:fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(Array.isArray(d.tools?.tools) ? d.tools.tools.length : -1))')"

if [[ -z "$INIT_VERSION" ]]; then
  fail "no valid initialize response (got $(wc -l <"$HANDSHAKE_OUT") JSON line(s)). stderr:"
  sed 's/^/      /' "$HANDSHAKE_ERR"
else
  pass "initialize answered (serverInfo.version=${INIT_VERSION})"
fi
if [[ "$TOOLS_COUNT" =~ ^[0-9]+$ ]] && [[ "$TOOLS_COUNT" -gt 0 ]]; then
  pass "tools/list non-empty (${TOOLS_COUNT} tools)"
else
  fail "tools/list empty or missing (count=${TOOLS_COUNT})"
fi

# ── version equality: a stale image must fail, not pass quietly ───────────────
note "==> [3/5] version equality (image vs packages/cli/package.json) ..."
if [[ -n "$INIT_VERSION" && "$INIT_VERSION" == "$EXPECTED_VERSION" ]]; then
  pass "serverInfo.version ${INIT_VERSION} == package.json ${EXPECTED_VERSION}"
else
  fail "version MISMATCH: image serves '${INIT_VERSION:-<none>}' but package.json is '${EXPECTED_VERSION}' (stale image?)"
fi

# ── no token/secret in the image ──────────────────────────────────────────────
note "==> [4/5] secret scan (env + layer history) ..."
SECRET_HITS="$( (docker inspect "${IMAGE_TAG}" | grep -ioE '"[^"]*(token|secret|password|private_key|api_key|passwd)[^"]*"\s*:\s*"[^"]*"' || true) | grep -viE 'telemetry|posthog' || true)"
HISTORY_HITS="$(docker history --no-trunc "${IMAGE_TAG}" | grep -ioE '(token|secret|password|private_key|api_key)[a-z_]*=[^ ]+' || true)"
if [[ -z "$SECRET_HITS" && -z "$HISTORY_HITS" ]]; then
  pass "no token/secret names in image env or layer history"
else
  fail "possible secret material in image:"
  [[ -n "$SECRET_HITS" ]] && printf '%s\n' "$SECRET_HITS" | sed 's/^/      env: /'
  [[ -n "$HISTORY_HITS" ]] && printf '%s\n' "$HISTORY_HITS" | sed 's/^/      history: /'
fi
EXPOSED="$(docker inspect -f '{{json .Config.ExposedPorts}}' "${IMAGE_TAG}")"
if [[ "$EXPOSED" == "null" || "$EXPOSED" == "{}" ]]; then
  pass "no exposed ports (stdio-only)"
else
  fail "image exposes ports (must be stdio-only): ${EXPOSED}"
fi

# ── non-vacuity: empty project dir MUST be refused ─────────────────────────────
note "==> [5/5] negative control (empty dir must be refused) ..."
NEG_OUT="$(mktemp)"
trap 'rm -f "$HANDSHAKE_OUT" "$HANDSHAKE_ERR" "$NEG_OUT"' EXIT
docker run --rm --entrypoint sh "${IMAGE_TAG}" -c \
  'mkdir -p /tmp/empty-probe && printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"0\"}}}" | timeout 60 node /app/dist/cli/index.js mcp --project /tmp/empty-probe' \
  >"$NEG_OUT" 2>&1 || true
if grep -q '"id":1' "$NEG_OUT" && grep -q '"result"' "$NEG_OUT"; then
  fail "negative control answered initialize for an EMPTY dir — the project guard may be gone, this check is vacuous"
else
  if grep -q "not a vibeflow project" "$NEG_OUT"; then
    pass "empty dir refused with 'not a vibeflow project' (check is non-vacuous)"
  else
    fail "empty dir gave neither initialize nor the expected refusal (got: $(head -c 200 "$NEG_OUT"))"
  fi
fi

if [[ "$KEEP_IMAGE" != "1" ]]; then
  docker rmi "${IMAGE_TAG}" >/dev/null 2>&1 || true
  note "      checked image removed (KEEP_IMAGE=1 to keep it)"
fi

if [[ "$failures" -gt 0 ]]; then
  printf 'RESULT: FAIL (%d failure(s))\n' "$failures"
  exit 1
fi
printf 'RESULT: PASS — image %s serves MCP stdio at v%s (%s tools), no secrets, negative control refused.\n' \
  "$IMAGE_TAG" "$EXPECTED_VERSION" "$TOOLS_COUNT"
