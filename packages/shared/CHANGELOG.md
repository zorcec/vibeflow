# @vibeflow-tools/shared

## 0.2.0

### Minor Changes

- 1be4fff: `delta-hash` is no longer re-exported from the package barrel; import it from
  `@vibeflow-tools/shared/delta-hash`.

  The barrel re-export broke the CLI release build outright: `delta-hash` imports
  `node:crypto`, so any consumer touching the index pulled it in — including the
  CLI's browser-target overlay bundle, whose esbuild pass failed with
  `Could not resolve "node:crypto"`. `node scripts/build-atomic.mjs` could not
  complete, which means `vibeflow` could not be built or published at all.

  The subpath export was always the supported entry point; the barrel re-export was
  added later and reintroduced exactly the bundler hazard the subpath exists to
  avoid. Keeping it out of the barrel makes the failure impossible to reintroduce
  by accident.

- 581f5e9: Add `canonicalJson`, `sha256Hex` and `hashTaskRecord` to the shared package.

  The CLI and the web server must serialise a task record identically before comparing
  hashes, otherwise every push marks every task as changed (jsonb does not preserve key
  order). Keeping one implementation in shared removes that failure mode. `canonicalJson`
  is moved verbatim from the private repo's `import-record.ts`, which now re-exports it,
  so the existing comparison in the import route is unchanged.

- 166d9d8: Task descriptions now have one length limit instead of three, and the limit is
  visible before it is hit.

  `TASK_DESCRIPTION_MAX = 20_000` is exported from `@vibeflow-tools/shared` and used
  by every schema that accepts a description. The overlay API previously capped at
  5,000 while the web form capped at 10,000 and Postgres (`text`) capped at nothing
  — so a description accepted by the form was silently refused by the bookmarklet,
  and anything over 10,000 produced a bare `400 Bad Request` with no field, no
  limit and no explanation.

  `MarkdownEditableField` gained an optional `charLimit`: it sets `maxLength` so an
  over-limit submit is impossible by typing or pasting, and renders a
  `N / limit` counter **only near the cap** (revealed in the last 2,000 characters,
  amber in the last 500). Fields without a cap, such as comments, are unchanged.

### Patch Changes

- c4488d7: Accept any non-empty comment author label and preserve commit entries whose SHA is not yet known, without changing canonical task serialization.
- b3eb912: Add shared compression policy (`compression.ts`): the single source of truth for text-artifact brotli eligibility, quality (5), and the shrink rule. Both the CLI uploader and the server at-rest storage implement it from here, so the rules can never drift apart again. Baselines (`baseline-*.json`) are eligible everywhere, matching the server-side rule.

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
