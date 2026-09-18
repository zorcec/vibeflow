# @vibeflow-tools/shared

## 0.1.1

### Patch Changes

- 6a1467e: The SaaS/online task contract now carries the `verified` tri-state instead of dropping it.

  `updateTaskSchema.patch` accepts `verified` as a nullable boolean — `true`/`false` are the agent's verdicts, `null` clears it back to absent, and omitting it leaves the stored value untouched. The CLI's online client (`SaasTask`, `updateSaasTask`) understands the same tri-state, so a local `--verified` / `--verify-failed` / `--unset-verified` is no longer lost on the way to or from the server: `vibeflow push` already ships the raw task JSON, and the server now round-trips the field unchanged. An absent verdict stays absent — it is never coerced to `false`, which would report a never-assessed task as failed verification.
