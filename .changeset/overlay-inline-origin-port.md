---
"@vibeflow-tools/cli": patch
---

Fixed the overlay resolving its API origin to the page's own host when injected without a script `src` (eval'd snippet, bookmarklet eval, or inlined bundle) on a page served from a different port than the API server. The generated config now keeps the page hostname but uses the port it was generated for when the ports disagree, so task, pages, screenshots, and realtime URLs reach the API server instead of 404ing against the page host. Same-server inline injection resolves exactly as before.
