---
"@vibeflow-tools/cli": patch
---

The review gate emits its error **code** under `--json`.

A review transition refused by the shared review gate (`checkReviewTransition` — the same code the MCP `update_task` tool and the PATCH route run) previously printed human prose on stdout even with `--json`; the CLI's duplicate comment pre-check returned before the gate could be consulted. That duplicate is deleted — the unified gate is the single source of truth — and a gate refusal now writes the standard `{ok:false, error:{code, message, retryable, suggestion}}` envelope to **stderr** with exit code 2. All gate codes are covered: `REVIEW_COMMENT_REQUIRED`, `COMMIT_MESSAGE_REQUIRED`, `BRANCH_REQUIRED`, `VERIFY_REQUIRED`, `VERIFY_FAILED_ATTESTED`, `VERIFY_REASON_REQUIRED`, `RESEARCH_REPORT_REQUIRED`, `RESEARCH_VERIFY_NOT_ALLOWED`.

The richer implementation-report guidance ("what was changed and why · key decisions and trade-offs · anything future agents should know") moved from the deleted CLI pre-check into the gate's own suggestion, so the CLI, MCP and PATCH surfaces all show it. Human (non-`--json`) output keeps the same guidance and exit code.
