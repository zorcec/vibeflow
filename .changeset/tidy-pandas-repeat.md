"@vibeflow-tools/cli": patch
---

Isolate HOME for the e2e worker process so the owner-global ~/.vibeflow/settings.json (e.g. autoCommit: true) no longer leaks into throwaway temp task stores and flips review-gate behaviour depending on who runs the suite. Product behaviour unchanged: loadSettings() still merges global settings for real projects. Adds a regression test asserting temp stores ignore an owner-global autoCommit.
