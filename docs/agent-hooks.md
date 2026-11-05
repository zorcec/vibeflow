# Agent hooks

Team policy without editing the binary: a `before` gate that can block a write,
and an `after` whisper that appends instructions to an agent's prompt.
Decision record: `docs/decisions/0007-agent-hooks.md` (ADR-0007, supersedes ADR-0006).
Implementation: `packages/cli/src/core/hooks/`. Registry: `tools.ts`.
Every statement below names the file that proves it — if the code and this doc
ever disagree, the code wins and the doc must be fixed in the same commit.

## Scope

Local CLI + local stdio MCP only. `--no-verify` says so on every gated
command (`packages/cli/src/index.ts`), and the MCP bypass arrives as
`ctx.hookBypass` set by the dispatch (`packages/cli/src/mcp/server.ts`).
Hosted clients are out of scope: a hook is a local child process and there
is no channel that could run one remotely.

## Tool keys (27, registry-owned)

A hook file is named after its TOOL, not an internal event (`HOOK_TOOLS` in
`tools.ts` — the one table discovery, the invocation boundary, the contract
test and this doc all read). `<tool>` is the canonical commander command
path (`tasks`, `auth.login`) or the MCP tool name (`create_task`);
`pull` is the only key shared by both surfaces (the envelope's `surface`
field tells a hook which one it is — no cross-surface fallback:
`create_task.after.mjs` does not fall back to `tasks.after.mjs`).
Hidden aliases resolve to their canonical key (`login`→`auth.login`,
`logout`→`auth.logout`, `status`→`auth.status`); `authors` is a container
node with no action and `help` is commander-owned — neither is hookable.

| key | surface | `.before` | `.after` | activities |
| --- | --- | --- | --- | --- |
| `tasks` | cli | ✓ | ✓ per effect; once with `activity:null` otherwise | create, update, claim, delete, comment |
| `pull` | cli + mcp | ✓ | ✓ | pull |
| `push` | cli | ✓ | ✓ | push |
| `verify` | cli | ✓ | ✓ | verify |
| `serve` | cli | ✗ `HOOK_NOT_GATEABLE` | ✓ at listening (`{url}`) | — |
| `kanban` | cli | ✗ `HOOK_NOT_GATEABLE` | ✓ at listening (`{url}`) | — |
| `mcp` | cli | ✗ `HOOK_NOT_GATEABLE` | ✗ `HOOK_NO_AFTER` (the client owns the lifetime) | — |
| `changelog` | cli | ✗ `HOOK_NOT_GATEABLE` | ✓ | — |
| `openapi` | cli | ✗ `HOOK_NOT_GATEABLE` | ✓ | — |
| `telemetry` | cli | ✗ `HOOK_NOT_GATEABLE` | ✓ | — |
| `auth` | cli | ✗ `HOOK_NOT_GATEABLE` | ✓ | — |
| `auth.login` | cli | ✗ `HOOK_NOT_GATEABLE` | ✓ | — |
| `auth.logout` | cli | ✗ `HOOK_NOT_GATEABLE` | ✓ | — |
| `auth.status` | cli | ✗ `HOOK_NOT_GATEABLE` | ✓ | — |
| `authors.link` | cli | ✗ `HOOK_NOT_GATEABLE` | ✓ | — |
| `authors` | cli | ✗ `HOOK_CONTAINER_TOOL` | ✗ `HOOK_CONTAINER_TOOL` | — |
| `create_task` | mcp | ✓ | ✓ | task.create |
| `update_task` | mcp | ✓ | ✓ | task.update |
| `claim_next_task` | mcp | ✓ | ✓ | task.claim |
| `add_comment` | mcp | ✓ | ✓ | task.comment |
| `verify_task` | mcp | ✓ | ✓ | verify |
| `list_tasks` | mcp | ✗ `HOOK_NOT_GATEABLE` | ✓ (`{count}`) | — |
| `get_task` | mcp | ✗ `HOOK_NOT_GATEABLE` | ✓ (task = the record) | — |
| `get_file` | mcp | ✗ `HOOK_NOT_GATEABLE` | ✓ (task = the record) | — |
| `attach_file` | mcp | ✗ `HOOK_NOT_GATEABLE` | ✓ (task = the target) | — |
| `get_project` | mcp | ✗ `HOOK_NOT_GATEABLE` | ✓ | — |
| `start_kanban` | mcp | ✗ `HOOK_NOT_GATEABLE` | ✓ (`{url}`) | — |
| `get_integration_guide` | mcp | ✗ `HOOK_NOT_GATEABLE` | ✓ | — |

`.before` is supported only for gateable tools (a tool whose invocation performs
one of the 8 activities); a `.before` file for any other tool is refused loudly
(`HOOK_NOT_GATEABLE`), never silently ignored. A before-hook exists to refuse a
write — a read has nothing to refuse.

## Filenames

One hook file per `<tool>.<phase>` (`discover.ts`), flat in each hooks root:

- `<tool>.before.mjs` / `<tool>.after.mjs` — stdio mode: one envelope JSON on stdin, one JSON document on stdout.
- `<tool>.before.hook.mjs` / `<tool>.after.hook.mjs` — module mode: default export via the packaged `hook-loader.mjs`.
- `<tool>.before.hook.mts` / `<tool>.after.hook.mts` / `<tool>.before.hook.ts` / `<tool>.after.hook.ts` — module-ts mode: same loader, type-stripped on import.

`HOOK_BAD_EXTENSION` for `.<phase>.js`/`.cjs`/bare-`.ts`/bare-`.mts` (present but
never executed, reported loudly); anything else in the directory (`trust.json`,
`bypass-audit.log`, `*.config.json`) is ignored. Unknown `<tool>` names report
`HOOK_UNKNOWN_TOOL`. Two or more executables at one level is `HOOK_CONFIG_CONFLICT`.

## The envelope (v2, generic contract)

Every hook — before or after, every activity, plus activity-null narrations —
receives exactly ONE JSON document on stdin with the SAME shape
(`buildHookEnvelope` in `envelope.ts` is the one builder; nothing else may
assemble one, pinned by `envelope.test.ts`):

```jsonc
{
  "schemaVersion": 2,
  "tool": "tasks",
  "surface": "cli",
  "phase": "before",
  "activity": "task.update",
  "payload": { "taskId": "…", "changed": ["status"] },
  "task": { /* full immutable record */ },
  "activityObject": { /* secondary record when one exists */ },
  "instructions": "",
  "boardId": null,
  "actor": "…",
  "ts": "2026-11-06T…Z"
}
```

- `tool` is the canonical hook key (never an alias); `surface` is `"cli"` | `"mcp"`.
- `phase` is `"before"` | `"after"` — one vocabulary everywhere (filenames, codes, types).
- `activity` is the 8-member enum or `null` when the invocation had no durable effect (reads, `kanban`/`serve`/`auth`); `payload` is the intent (before) or confirmed (after) activity payload, `null` iff `activity` is `null` (`HookIntentPayloads` vs `HookConfirmedPayloads` in `envelope.ts` — distinct types on purpose; no generated ids before the write).
- `task` is the full immutable snapshot — confirmed post-write record, best-known intent before it — or `null` where no single task exists. `activityObject` is the secondary record when one exists (changed keys, written comment, claim filters). `instructions` is the ONLY replaceable surface.

After-envelope content per activity (`emit.ts` + operation call sites):

| activity | `task` | `activityObject` |
| --- | --- | --- |
| `task.create` | the written record | — |
| `task.update` | the post-write record | `{changed: string[]}` |
| `task.claim` | the claimed record | the claim filters |
| `task.delete` | the **pre-delete** row (gone post-write) | — |
| `task.comment` | the commented task | the written comment |
| `push` / `pull` | `null` (run intent, no single task) | — |
| `verify` | `null` (run intent) | — |
| `null` activity, single-task read (`get_task`, `get_file`, `attach_file`, `tasks --get`) | the read/target record | — |
| `null` activity, listing (`list_tasks`, `tasks` list mode) | `null` | `{count: number}` |
| `null` activity, `kanban` / `serve` / `start_kanban` | `null` | `{url: string}` |
| `null` activity, everything else | `null` | — |

## Execution count (one per (tool, activity))

One invocation of a multi-activity command fires the tool's before/after hook
once per activity, in operation order (`tasks --edit <id> --set-status review
--comment "…"` → 2 before runs, 2 after runs). A successful invocation that
emitted no activity fires the after hook exactly once with `activity: null`.
Failed/refused/dry-run invocations fire no after hook. Dedup is
action-scoped (`HookScope` in `emit.ts`, created per invocation by
`beginToolInvocation` in `invocation.ts`): two separate actions in one
process each run their hooks; the scope only collapses a double fire for the
same effect inside one action.

## Failure policies

Opposite and load-bearing (`runner.ts`): `.after` is fail-OPEN (timeout,
non-zero exit, non-JSON, bad shape, output limit, spawn/stdin failure, TS
unsupported ⇒ one stderr line, no instructions, the write already happened);
`.before` is fail-CLOSED (the same list plus malformed decision, config
conflict, untrusted project hook, TS unsupported ⇒ the gated write is refused
with `beforeGateRefusal` and a non-zero exit).

Bounds: 2 s per-invocation deadline (`HOOK_INVOCATION_TIMEOUT_MS`, detached-group
SIGKILL), 1 MiB stdout/stderr caps (`HOOK_MAX_OUTPUT_BYTES`), child env
allowlist `PATH` + `HOME` + `VIBEFLOW_IN_HOOK` only, reentrancy guard
(`VIBEFLOW_IN_HOOK=1` disables nested hooks, not nested writes), stdout purity
(the runner never writes parent stdout), `VIBEFLOW_HOOKS=0` kill switch.

`--no-verify` skips the gate LOUDLY on the 4 gated CLI commands (`tasks`,
`push`, `pull`, `verify`) and via `ctx.hookBypass` on MCP: `HOOK_BYPASSED
<tool>` on stderr plus one JSONL record (`tool`, `activity`, `phase`,
`command`, `reason`) in `~/.vibeflow/hooks/bypass-audit.log` (`bypass.ts`);
after-hooks still run. A bypassed gate leaves `scope.seen` empty for that
activity, but the effect's after hook still runs from the operation — so the
boundary's null-activity rule never double-fires for it.

## Authoring modes

- `.mjs` — stdio protocol: stdin = one envelope JSON + `"\n"`; stdout = exactly one JSON document (`{"instructions":"..."}` or `{}`); diagnostics on stderr ONLY.
- `.hook.mjs` — module mode: `export default` a (possibly async) function receiving the envelope as its ONE argument; the packaged `hook-loader.mjs` owns stdin/stdout.
- `.hook.ts` / `.hook.mts` — TypeScript module mode: same loader, type-stripped on import. Erasable syntax only (annotations + `import type` erased; no enums, no namespaces, no JSX, no tsconfig paths, no transpilation). A runtime without type stripping refuses loudly (after skips `HOOK_TS_UNSUPPORTED`, before blocks `HOOK_BEFORE_TS_UNSUPPORTED`).

Typed authoring ships as type-only declarations (`@vibeflow-tools/cli/hooks`
— no runtime API; `src/hooks.ts`, parity-pinned with `envelope.ts`):

```js
// .vibeflow-hooks/tasks.after.hook.mjs
// @ts-check
/** @type {import('@vibeflow-tools/cli/hooks').HookAfterHandler<'task.update'>} */
export default async (envelope) => {
  return { instructions: `saw ${envelope.activity} (${envelope.payload.taskId})` };
};
```

## Precedence + defaults in the package

`project .vibeflow-hooks/` > `global ~/.vibeflow/hooks/` > shipped
`node_modules/@vibeflow-tools/cli/dist/hooks/defaults/`, flat at every level
(`discover.ts`). The first hit wins; an override REPLACES (never merges); two
or more executables at one level is `HOOK_CONFIG_CONFLICT` with no fallback.

Shipped defaults are read IN PLACE from the installed package (`VERSION` + 9
`*.after.mjs` files — one per activity-bearing tool key, no `.before`
defaults), trusted without prompting, upgraded by `npm`/`pnpm update`. The
root is DERIVED from the running bundle (`resolveShippedDefaultsDir`), so npm
nested installs, pnpm symlink-into-store, npx cache, global install and
tarball all resolve with no path allowlist. If no shipped tree resolves, one
loud `HOOK_SHIPPED_DEFAULTS_MISSING` line names the miss — never a silent
fallback. `~/.vibeflow/hooks/defaults/` is OBSOLETE — earlier builds copied
the defaults there; nothing reads it now. Delete it: `rm -rf
~/.vibeflow/hooks/defaults`.

## Trust

Trusting a hook grants CODE EXECUTION on the machine — it is not a sandbox
(`trust.ts`). Only project hooks prompt (direnv-style sha256 in `trust.json`;
`[y/N/d]`, non-TTY refuses by design, `VIBEFLOW_TRUST_HOOKS=1` bypasses
explicitly). Global and shipped defaults are the user's own bits — trusted
without prompting and without a hash record (a prompt on package content
would fire on every `pnpm update` and be unanswerable in non-TTY). A symlink
escaping its own root never inherits trust in either direction (a shipped
file that symlinks out is refused as `HOOK_SHIPPED_ESCAPED`).

## Secrets + config files

The child env carries ONLY `PATH`, `HOME`, `VIBEFLOW_IN_HOOK` — never the
operator's env, never any token. A hook that needs configuration reads a
hook-owned JSON file (see `docs/hooks-examples/verify.after.mjs`, which
reads `.vibeflow-hooks/verify.after.config.json` with a `$HOME` fallback —
`chmod 600`, it may hold a secret). NEVER put a token near hooks: they never
need one. (The `childEnv` allowlist lives in `runner.ts`.)

## Examples

| file | install as | what it proves |
| --- | --- | --- |
| `docs/hooks-examples/tasks.after.mjs` | `.vibeflow-hooks/tasks.after.mjs` | stdio nudge on the review move; `{}` otherwise |
| `docs/hooks-examples/tasks.after.hook.ts` | `.vibeflow-hooks/tasks.after.hook.ts` | module-ts nudge; type-stripped at runtime |
| `docs/hooks-examples/verify.after.mjs` + `verify.after.config.example.json` | `.vibeflow-hooks/verify.after.mjs` (+ config) | webhook post; swallowed failures (fail-open) |

All three run VERBATIM through the packaged CLI (see the ticket) — byte-identical, never rewritten.

## Writing your own

One executable per (tool, phase) per level. Read the envelope's
`tool`/`activity`/`phase` (never your own filename) and return
`{instructions}` or `{}` (after) / `{allow, instructions?}` or
`{allow:false, reason}` (before). There is no `mcp.after` (the client owns
the lifetime) and no `.before` on reads (a read has nothing to refuse) —
files for those cells are refused loudly, never silently ignored.
