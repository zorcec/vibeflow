---
"@vibeflow-tools/ui": patch
---

Document the web runtime in the shared codec layer's contract: like the CLI browser bundles, the web app now serves the jsquash wasm binaries from its own origin (`/__vibeflow__/codecs`, shipped in `packages/web/public`), so web/SaaS uploads run the same transform matrix. The loader API is unchanged — `configureWasmBaseUrl` already accepted any base URL.

### Highlights

- The shared image-codec layer now names both runtimes it serves: the CLI server route and the web app's own origin both feed the same lazy wasm loader, so one transform matrix covers every upload path.
