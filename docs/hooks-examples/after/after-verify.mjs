// Example after-hook: post the verify verdict to a webhook (ntfy/Slack).
//
// Copy VERBATIM to `.vibeflow-hooks/after/after-verify.mjs` — no edits needed,
// but it only posts when its hook-owned config file exists (see below).
// Removal restores the shipped default for `verify` (ADR-0006: REPLACE).
//
// Why a config file and not an env var (Sol review #9): the hook child env
// carries ONLY PATH, HOME and VIBEFLOW_IN_HOOK (`childEnv` in
// `packages/cli/src/core/hooks/runner.ts`) — never the operator's env, never
// any Vibeflow token. A webhook URL in YOUR env is invisible to this process,
// so "reads $NTFY_URL" examples cannot work verbatim. This hook instead reads
// a hook-owned JSON config file — the ONLY user-controlled channel that
// actually reaches the child (cwd is the project root, HOME is provided):
//   1. `<project>/.vibeflow-hooks/after-verify.config.json` (per-project), else
//   2. `$HOME/.vibeflow/hooks/after-verify.config.json` (per-user fallback).
// Config shape: { "url": "https://ntfy.sh/<topic>", "headers": { ... } }.
// For Slack use your incoming-webhook URL as `url`. `chmod 600` the file —
// it holds a secret. NEVER put a Vibeflow token here or anywhere near hooks:
// hooks never need one (the child env never carries one by construction).
//
// Contract (ADR-0006): stdin = one envelope JSON + "\n"; stdout = exactly one
// JSON document (`{}` here — a notifier adds no prompt text); diagnostics on
// stderr ONLY (stdout must stay byte-clean: a stray console.log invalidates
// the whole document and the runner drops the hook with HOOK_BAD_OUTPUT).
// Must finish well inside the 2 s per-invocation deadline, so the POST is
// capped at 1500 ms. Any failure (no config, no network, non-2xx) is
// swallowed: after-hooks are fail-open and the verdict already landed.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const POST_TIMEOUT_MS = 1500;

function configPath() {
  const home = process.env.HOME ?? "";
  const candidates = [join(process.cwd(), ".vibeflow-hooks", "after-verify.config.json")];
  if (home) candidates.push(join(home, ".vibeflow", "hooks", "after-verify.config.json"));
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.url === "string" && parsed.url.length > 0) return parsed;
    } catch {
      // Missing/unreadable/invalid — try the next candidate.
    }
  }
  return null;
}

async function main() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  let envelope = null;
  try {
    envelope = JSON.parse(text.trim());
  } catch {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }
  // Defensive: the filename already selects after/verify, but never post on
  // a document this hook does not understand.
  if (!envelope || envelope.event !== "verify" || envelope.phase !== "after") {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }
  const config = configPath();
  if (!config) {
    process.stderr.write("after-verify: no config file — skipping post (see after-verify.config.example.json)\n");
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }
  const payload = envelope.payload ?? {};
  const body = JSON.stringify({
    text: `vibeflow verify: task ${payload.taskId ?? "?"} → ${payload.verdict ?? "?"}`,
    taskId: payload.taskId ?? null,
    verdict: payload.verdict ?? null,
    actor: envelope.actor ?? null,
    ts: envelope.ts ?? null,
  });
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.headers ?? {}) },
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) process.stderr.write(`after-verify: POST ${res.status} — verdict already recorded, hook output dropped\n`);
  } catch (err) {
    process.stderr.write(`after-verify: POST failed (${err instanceof Error ? err.message : String(err)}) — verdict already recorded\n`);
  }
  process.stdout.write(JSON.stringify({}) + "\n");
}

await main();
