---
"@vibeflow-tools/cli": patch
---

Add semantic exit codes to the CLI. Instead of always exiting with code 1, the CLI now uses purpose-specific codes: 2 for usage/argument errors, 3 for not-found, 4 for auth failures, and 5 for conflicts. Exit code 1 is reserved for general/unexpected errors.
