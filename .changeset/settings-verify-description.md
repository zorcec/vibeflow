---
"@vibeflow-tools/cli": patch
---

Fix the "Require verify before review" description in Settings — it described the wrong mechanism and ran long.

The copy said the CLI "enforces vibeflow verify before setting status to review". That is not what happens: the gate requires the agent's `--verified` **attestation** at the review transition. `vibeflow verify` only gathers evidence — it cannot decide whether the task was accomplished, and it does not set the flag. The description now names the attestation, keeps the scope (tasks with a URL and selector) and the reset behaviour (cleared when the task returns to in-progress), and is roughly a third shorter.
