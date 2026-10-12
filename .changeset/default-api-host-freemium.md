"@vibeflow-tools/cli": patch
---

Default API host is now the live production host

Login and push defaulted to a hostname that was never served, so they could not connect for anyone. The default is now the production host (`VIBEFLOW_API_URL` still overrides it for local dev, stage and tests), shared from one module instead of five duplicated constants.
