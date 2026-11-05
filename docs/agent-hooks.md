# Agent hooks

Team policy without editing the binary: a `pre` gate that can block a write,
and an `after` whisper that appends instructions to an agent's prompt.
Decision record: `docs/decisions/0006-agent-hooks.md` (ADR-0006).
Implementation: `packages/cli/src/core/hooks/`. Every statement below names
the file that proves it — if the code and this doc ever disagree, the code
wins and the doc must be fixed in the same commit.

## Scope

Local CLI + local stdio MCP only. `--no-verify` says so on every gated
command (`packages/cli/src/index.ts`), and the MCP bypass arrives as
`ctx.hookBypass` set by the local stdio MCP host
(`packages/cli/src/mcp/manifest.ts`). Hosted clients are out of scope:
a hook is a local child process and there is no channel that could run one
remotely.

## Events (8, operation-owned)

`task.create`, `task.update`, `task.claim`, `task.delete`, `task.comment`,
`push`, `pull`, `verify` (`HookEvent` in `envelope.ts`). There is no
`task.list`, no files/links/boards event: an event exists only when
something must be gated or narrated.

Each event is emitted by the OWNING operation after its CONFIRMED durable
effect (`emit.ts`): `push`/`pull`/`verify` are not store methods, so a store
decorator could not emit them anyway. Dry-run and no-op emit nothing (null
claim, empty push, scope refusal — the caller simply does not call);
partial success emits only the confirmed effect (update persisted but
comment failed → `task.update` only, never `task.comment`). Generated system
comments (verify notes, bypass-audit notes, `cannot` reasons) are written
via the store directly and never pass through an emitting call site, so no
hook cycle is possible by construction.

## The envelope (generic contract)

Every hook — pre or after, all 8 events — receives exactly ONE JSON document
on stdin with the SAME shape (`buildHookEnvelope` in `envelope.ts` is the
one builder; nothing else may assemble one):

- 6 shared fields: `schemaVersion` (literal `1`, versions the ENVELOPE
  contract, not the package), `event`, `phase` (`"pre"` | `"after"`),
  `boardId` (always `null` locally — a local board has no server-side
  identity, and naming a workspace pointer here would leak project layout),
  `actor` (explicit context user, else `VIBEFLOW_ACTOR`, else
  `USER`/`USERNAME`, else `"agent"`), `ts`.
- `payload`: the legacy event payload, byte-identical. Pre-phase carries
  INTENT (fields known before the write — no generated ids: no task id on
  create, no commentId, no verdict; claim pre-gate runs over the claim
  FILTERS because claim is atomic), after-phase carries the CONFIRMED
  record (`HookPrePayloads` vs `HookAfterPayloads` in `envelope.ts` —
  distinct types on purpose).
- `task`: the full task where the emitter provides one — snapshot after
  the write, best-known intent before it — or `null` where no single task
  exists (push/pull/verify run intents). CURRENT BUILD (verified
  2026-11-05 against `emit.ts` + a live capture): the PRE gate populates
  `task`/`activityObject` from its input, but `emitAfterHook` takes only
  the payload, so every AFTER envelope today carries `"task":null` and
  no `activityObject` — the confirmed effect rides `payload` alone. An
  after-hook that needs task state reads it from the store (`cwd` is the
  project root) or waits for the gate to be closed (reported on ticket
  pgli5zy761vwfvddx41r203h — core change, NOT made here). Immutable JSON
  copy by contract wherever present: hooks cannot alter the store
  through it.
- `activity`: explicit activity enum, always equals `event` (redundant on
  purpose — generic consumers read ONE field).
- `activityObject`: the secondary record when one exists (comment text,
  changed keys, claim filters, …). Absent otherwise.
- `instructions`: the current agent-instruction draft — the ONLY replaceable
  surface. Empty pre-write.

## Pre vs after: opposite failure policies

After-hooks run AFTER the write, so they fail OPEN (`runAfterHook` in
`runner.ts`): timeout, non-zero exit, non-JSON stdout, bad shape, and output
over the byte limit each drop the hook with ONE stderr line
(`HOOK_TIMEOUT`, `HOOK_NONZERO_EXIT`, `HOOK_BAD_OUTPUT`, `HOOK_OUTPUT_LIMIT`,
`HOOK_SPAWN_FAILED`, `HOOK_STDIN_FAILED`) — never a throw, never a blocked
write. Success is `{"instructions":"..."}` or the no-op `{}`; `undefined`,
empty stdout, wrong-typed `instructions`, and extra keys are all rejected,
never coerced.

Pre-hooks run BEFORE the write, so they are fail-CLOSED gates
(`runPreHook`): timeout, non-zero exit, non-JSON stdout, malformed decision,
import error, and explicit `{allow:false,reason}` ALL block the gated write
with the existing refusal shape and a non-zero exit. Success is an explicit
`{allow:true}` (optional replacement `instructions`); denial is
`{allow:false,reason}` with a non-empty reason. Anything else is
`HOOK_PRE_MALFORMED` — never a silent pass. An UNTRUSTED project pre-hook
blocks (`HOOK_PRE_UNTRUSTED`); an untrusted AFTER-hook only skips with a
notice — the write already happened, so there is nothing left to protect.

## Bypassing the gate (`--no-verify`)

Every gated command accepts `--no-verify`. It skips the pre-gate but never
silently: each bypassed invocation prints `HOOK_BYPASSED <event>` on stderr
AND appends one JSONL record to the universal local audit file
`~/.vibeflow/hooks/bypass-audit.log` (`bypass.ts`; task activity comments
are supplementary only — push/pull/deleted tasks have no task to comment
on, so the local file is the record of truth). An audit-write failure warns
on stderr and NEVER blocks the bypassed command. After-hooks still run.
`VIBEFLOW_HOOKS=0` disables ALL emission including gates (explicit
kill-switch, used by the test setup for hermeticity).

## Authoring modes (`.mjs` vs `.hook.mjs`)

Mode is chosen by FILENAME EXTENSION only — never by source inspection
(`discover.ts`):

- `pre-<event>.mjs` / `after-<event>.mjs` — stdio mode: the CLI spawns the
  file itself with `process.execPath`, writes the envelope to stdin.
- `pre-<event>.hook.mjs` / `after-<event>.hook.mjs` — module mode: the CLI
  spawns the packaged `hook-loader.mjs` with the hook file as its argument;
  the loader dynamic-imports the default export and calls it with the
  envelope as its SOLE argument (module code must not read stdin or write
  protocol output — the loader owns both streams). The awaited return value
  is serialised once to stdout; `undefined`, thrown handlers, and
  unserializable returns exit non-zero. A `console.log` in module code lands
  on child stdout, invalidates the document, and the parent parser rejects
  it. Never in-process JS.

Both modes share the deadline, byte limits, env allowlist, trust, parser,
and failure policy. Both files at ONE level is `HOOK_CONFIG_CONFLICT` —
a configuration error with NO fallback to a lower level: pre REFUSES the
gated write, after SKIPS with a diagnostic (fail-open: the write happened).
Only `*.mjs` executes; a `.js`/`.cjs` peer is REFUSED LOUDLY
(`HOOK_BAD_EXTENSION`) — an ignored file that looks like policy but never
runs is worse than no hook. Unknown event filenames warn once
(`HOOK_UNKNOWN_EVENT`) and are never guessed at.

## Precedence (replace, never merge)

Project (`.vibeflow-hooks/`) beats global (`~/.vibeflow/hooks/`) beats
shipped default (`~/.vibeflow/hooks/defaults/`, materialised from the bundle
on version change — edits there are lost on upgrade by design). The FIRST
hit wins and an override REPLACES the default: a later default change
cannot silently alter overridden behaviour. Removing your override restores
the shipped default automatically. A symlink that escapes its own trust root
never inherits trust from either side (`escapedRoot` in `discover.ts` +
`checkHookTrust`).

## Bounds (every invocation)

- **2 s deadline PER INVOCATION** (`HOOK_INVOCATION_TIMEOUT_MS` in
  `runner.ts`), covering import + handler + serialization. Expiry SIGKILLs
  the child AND its detached process group, so grandchildren holding
  inherited pipes open cannot outlive the deadline. A command that emits
  several events invokes several hooks — the budget is per hook, not per
  command.
- **1 MiB stdout / 1 MiB stderr caps** (`HOOK_MAX_OUTPUT_BYTES`): a hook
  that floods output is truncated and treated as failure, never buffered
  into OOM.
- **stdout purity**: the runner NEVER writes to `process.stdout` — hook
  chatter is stderr-only (prefixed `hook <event>:`), so `--json` stays
  byte-clean for piping. Hook stdout must be exactly one JSON document.
- **Child env allowlist**: `PATH` + `HOME` + `VIBEFLOW_IN_HOOK` ONLY
  (`childEnv` in `runner.ts`) — never the API token, never your shell env.
  Hooks run with `cwd` = project root.
- **Reentrancy guard**: the child runs with `VIBEFLOW_IN_HOOK=1`; a nested
  `vibeflow …` inside a hook runs fine but emits NO further hooks — a cycle
  breaker, not a write lock.

## Trust (code execution, not a sandbox)

Trusting a hook grants CODE EXECUTION on your machine — it is not a sandbox
(`trust.ts`, and the prompt says so plainly). Only PROJECT hooks prompt
(direnv-style sha256 in `~/.vibeflow/hooks/trust.json`); global and shipped
defaults are your own bits and never prompt. New file or changed hash →
prompt `Run project hook …? [y/N/d]` (`d` prints the file first); anything
but `y` does not run. Non-TTY (agents/CI/MCP) cannot prompt → NOT run, by
design. Escape hatch: `VIBEFLOW_TRUST_HOOKS=1` (explicit, logged on stderr).
Honest limit: the recorded hash covers the ENTRY FILE ONLY, not its import
graph — a trusted `.mjs` approves everything it imports, and the child
reads with your HOME (and therefore your credentials) visible.

## Secrets: the hook-owned config file (Sol review #9)

The child env carries ONLY `PATH`, `HOME`, and `VIBEFLOW_IN_HOOK` — your
webhook variables are invisible to the hook, so an example that reads
`$NTFY_URL` cannot work verbatim. Since the hook boundary is
review-required, examples do NOT get an env-forwarding mechanism; instead
each hook reads a HOOK-OWNED JSON config file — the only user-controlled
channel that actually reaches the child:

1. `<project>/.vibeflow-hooks/<hook>.config.json` (per-project), else
2. `$HOME/.vibeflow/hooks/<hook>.config.json` (per-user fallback).

Both resolve because `cwd` is the project root and `HOME` is provided.
`chmod 600` the file — it holds a secret. NEVER put a Vibeflow token in a
hook or its config: hooks never need one (the child env never carries one
by construction), and a hook that exfiltrates credentials is exactly what
the trust prompt warns about.

## Examples (copy-in flow)

Shipped under `docs/hooks-examples/` (filenames mirror the hooks layout):

| File | Install as | Needs |
| --- | --- | --- |
| `after/after-verify.mjs` | `.vibeflow-hooks/after/after-verify.mjs` | hook-owned config `after-verify.config.json` (see `after-verify.config.example.json`); without it the hook no-ops with an stderr note |
| `after/after-task.update.mjs` | `.vibeflow-hooks/after/after-task.update.mjs` | nothing — pure, offline |

```bash
# Install (project level wins by precedence; TRUST it once from a terminal):
cp docs/hooks-examples/after/after-task.update.mjs .vibeflow-hooks/after/
cp docs/hooks-examples/after-verify.config.example.json .vibeflow-hooks/after-verify.config.json
# then edit the URL in the config and chmod 600 it.
# Global instead: ~/.vibeflow/hooks/after/ + ~/.vibeflow/hooks/*.config.json.
```

Both were exercised VERBATIM through the packaged CLI (real spawn, not
source): `after-task.update.mjs` returns its review nudge on
`tasks --edit --set-status review` and `{}` otherwise, with stdout staying
one JSON document; `after-verify.mjs` POSTs the verdict to the configured
URL on `vibeflow verify` and returns `{}` on every path including missing
config. Removing either file restores the shipped default (verified:
default text rides along again). Trust: run from an interactive terminal
once, or set `VIBEFLOW_TRUST_HOOKS=1` for the run.

## Writing your own

- One file per (phase, event): `pre-task.create.mjs` gates creation,
  `after-push.mjs` whispers after a push. Keep exactly ONE of `.mjs` /
  `.hook.mjs` per (phase, event) per level.
- Public authoring types (type-only, no runtime): `@vibeflow-tools/cli/hooks`
  (`HookAfterHandler<'task.update'>`, … in `packages/cli/src/hooks.ts`) —
  after-only union; no pre payload is promised to public authors.
- Instruction transport is one document or the existing failure channel:
  success carries `instructions: string[]` (absent when no hook ran, so a
  hook-free success stays byte-identical) through `OperationResult`, the CLI
  `--json` envelopes, and the MCP `successPayload`; failures keep their
  existing channel.
- Keep it under 2 s, stdout to exactly one JSON document, secrets in the
  hook-owned config file, and test it with `VIBEFLOW_TRUST_HOOKS=1` against
  the REAL CLI before trusting it for real.
