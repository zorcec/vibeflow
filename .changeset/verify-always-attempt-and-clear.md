---
"@vibeflow-tools/cli": patch
---

Agent instructions now tell an agent to attempt verification on **every** task, and give it a way to record that a task genuinely cannot be verified.

Verification is no longer implied to be optional evidence. The instructions state that a UI task (one with a URL and a selector) must run `vibeflow verify <id>` **and** be judged by the agent, because verify only proves the annotated element still resolves and that the page logged no NEW console errors — it cannot tell whether the ticket was accomplished. They name the real counterexamples that pass verify but are wrong (painting a button green when the ticket said red; fixing a different bug), and spell out how to verify a non-UI task by inspecting its artifact (for a rename, grep the old string and assert zero occurrences; for links, resolve every href and assert none 404; for a README, confirm every referenced file exists and ships in the package's `files` list; for a command reference, confirm each documented command exists in `--help`).

An unverifiable task must not carry a stale or false verdict, so `verified` can now be cleared back to absent with `tasks --edit <id> --unset-verified`. Absence means "not assessed here" and the kanban renders no badge for it, whereas `--verify-failed` still means "verified as WRONG" and is rejected by the review gate. The three attestation flags are mutually exclusive; combining them fails loudly.

Also fixes a silent no-op: `tasks --edit <id> --verified` (or `--verify-failed`) with no other edit used to fall through to the browse/help output and exit 0 without writing anything, because the edit guard omitted the attestation flags. The flags are now edits, so the attestation is written (or the clear performed) instead of silently discarded. The `dist/index.js` chunk sync now also copies the dynamically-imported `verify-attestation` chunk, which the CLI edit path loads at runtime.
