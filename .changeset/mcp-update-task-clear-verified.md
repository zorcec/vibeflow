---
"@vibeflow-tools/cli": patch
---

MCP `update_task` can now clear the `verified` attestation, matching `tasks --edit --unset-verified`.

Pass `verified: null` to remove the stored verdict and leave the task with no verdict at all — the honest state for a task that cannot be assessed on this surface. The field was previously `boolean`-only, so an MCP-based agent had no way to express "clear it": it could only leave a stale value or write `false`, and `false` is a completed verdict that the task IS implemented incorrectly, not "not assessed". `null` maps directly onto the tri-state's absent value and is distinct from `false`, which is still stored as a real failure verdict. Omitting the field continues to leave any stored verdict untouched. The tool description now spells out all three values, and the review gate treats `verified: null` as no attestation, so it can never satisfy the positive-attestation requirement.
