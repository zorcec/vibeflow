---
description: "Rules for generating HTML prototypes compatible with Vibeflow"
applyTo: "**/*.html"
---

# Vibeflow Rules

When generating HTML prototypes:

1. **One screen per file** — name files after their route (login.html, dashboard.html, etc.)
2. **Tailwind CSS via CDN** — add `<script src="https://cdn.tailwindcss.com"></script>` in head; use utility classes for all styling
3. **Lucide icons via CDN** — `<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>` and call `lucide.createIcons()`
4. **Google Fonts** — Inter via `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap`
5. **data-proto-id** (kebab-case, stable, unique per file and globally across files) on every meaningful element
6. **Navigation** — use relative `<a href="./page.html">` links; repeat nav verbatim in every file
7. Never rename or remove existing `data-proto-id` attributes
