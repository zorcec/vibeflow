---
"@vibeflow-tools/cli": patch
---

The review gate emits its error **code** under `--json`.

A review transition refused by the shared review gate (`checkReviewTransition` — the same code the CLI and the MCP `update_task` tool run) previously printed human prose on stdout even with `--json`; the CLI's duplicate comment pre-check returned before the gate could be consulted. That duplicate is deleted — the unified gate is the single source of truth — and a gate refusal now writes the standard `{ok:false, error:{code, message, retryable, suggestion}}` envelope to **stderr** with exit code 2. All gate codes are covered: `REVIEW_COMMENT_REQUIRED`, `COMMIT_MESSAGE_REQUIRED`, `BRANCH_REQUIRED`, `VERIFY_REQUIRED`, `VERIFY_FAILED_ATTESTED`, `VERIFY_REASON_REQUIRED`, `RESEARCH_REPORT_REQUIRED`, `RESEARCH_VERIFY_NOT_ALLOWED`.

The richer implementation-report guidance ("what was changed and why · key decisions and trade-offs · anything future agents should know") moved from the deleted CLI pre-check into the gate's own suggestion, so the CLI and MCP `update_task` both show it. Human (non-`--json`) output keeps the same guidance and exit code.

Two further refusals in the same command had the same defect and are also fixed: a Research task given `--set-verify` (`RESEARCH_VERIFY_NOT_ALLOWED`) and an invalid attestation flag combination (`VERIFY_REASON_REQUIRED`, or `E_USAGE` when `--verify-reason` is passed without `--set-verify cannot`) printed prose on stdout even under `--json`. Both now write the standard envelope to stderr with exit code 2, using the same codes the gate uses. A refused `--set-verify` therefore reports one code whichever path rejects it first.
