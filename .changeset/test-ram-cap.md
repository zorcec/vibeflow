"@vibeflow-tools/cli": patch
---

Cap the Playwright suite at 4 parallel files (was 8). Each file boots its own kanban server plus headless chromium (~0.9 GB per file), so 8-wide runs peaked at ~7.7 GB aggregate RSS; 4-wide peaks at ~4.6 GB for ~22% more wall time. No tests skipped or changed.
