# @vibeflow-tools/shared

## 0.1.3

### Patch Changes

- d2c57a2: Add `task.comment.update` to the shared live-event contract so an edited comment can propagate to other sessions without a reload. Additive only: shaped exactly like its `task.comment.add`/`task.comment.remove` siblings plus the edited body.

## 0.1.2

### Patch Changes

- 484fc7e: Polished presence UI for live collaboration

  Remote cursor colours now come from a fixed 12-colour palette, so two people in the same description always get easily told-apart colours that stay the same for each person across sessions; the peer-name flag on each cursor keeps a text shadow so it stays readable on the lightest colours. The card activity badge shows a pencil while someone is typing and an eye while they are only viewing, matching the presence line's wording. The presence line in the task panel wraps instead of overflowing on narrow screens. No behaviour changes: presence stays informational and never locks editing.

## 0.1.1

### Patch Changes

- 6a1467e: The SaaS/online task contract now carries the `verified` tri-state instead of dropping it.

  `updateTaskSchema.patch` accepts `verified` as a nullable boolean — `true`/`false` are the agent's verdicts, `null` clears it back to absent, and omitting it leaves the stored value untouched. The CLI's online client (`SaasTask`, `updateSaasTask`) understands the same tri-state, so a local `--verified` / `--verify-failed` / `--unset-verified` is no longer lost on the way to or from the server: `vibeflow push` already ships the raw task JSON, and the server now round-trips the field unchanged. An absent verdict stays absent — it is never coerced to `false`, which would report a never-assessed task as failed verification.
