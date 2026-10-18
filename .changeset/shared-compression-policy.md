---
"@vibeflow-tools/shared": patch
---

Add shared compression policy (`compression.ts`): the single source of truth for text-artifact brotli eligibility, quality (5), and the shrink rule. Both the CLI uploader and the server at-rest storage implement it from here, so the rules can never drift apart again. Baselines (`baseline-*.json`) are eligible everywhere, matching the server-side rule.
