---
"@vibeflow-tools/cli": patch
---

Agent hooks Stage 3: document the hook contract and ship two copy-in examples. `docs/agent-hooks.md` describes the envelope both phases receive, the fail-closed pre-gate versus fail-open after-hooks, `--no-verify` bypass audit, stdio versus module authoring modes, replace-not-merge precedence, invocation bounds, and the trust model — each statement checkable against the hook sources. `docs/hooks-examples/` adds a verify-verdict webhook notifier (reads its URL from a hook-owned config file, since the hook environment carries no credentials) and a review-move instruction nudge; both were exercised verbatim through the packaged CLI. No behaviour change.
