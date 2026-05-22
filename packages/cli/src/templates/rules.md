# Vibeflow — Annotation Contract

This document defines the rules that any LLM must follow when generating
HTML prototype files for use with Vibeflow.

---

## 1. One Screen Per File

Each HTML file represents **one screen** of the application. Do not put
multiple pages in a single file.

Name files after their route:

```
login.html
dashboard.html
settings.html
settings-profile.html
listings.html
listing-detail.html
```

Between screens, use plain relative anchor links:

```html
<a href="./dashboard.html">Go to Dashboard</a>
```

---

## 2. Preferred Libraries (use via CDN)

These are explicitly allowed and preferred. Use them by loading from CDN
so prototypes look close to the real product with minimal markup.

### Tailwind CSS — primary styling

```html
<script src="https://cdn.tailwindcss.com"></script>
```

Use Tailwind utility classes for all layout, spacing, color, and typography.
Do not write `<style>` blocks if Tailwind covers the need.

### Lucide Icons

```html
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
```

Use inline icon elements that Lucide replaces at runtime:

```html
<i data-lucide="search" class="w-4 h-4"></i>
<script>lucide.createIcons();</script>
```

### Google Fonts

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

Apply with Tailwind's arbitrary value or a one-line style:

```html
<style>body { font-family: 'Inter', sans-serif; }</style>
```

### Other allowed CDN sources

- `cdn.jsdelivr.net` — any library
- `unpkg.com` — any library
- `cdnjs.cloudflare.com` — any library
- `esm.sh` — ES module imports

---

## 3. File Structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>App Name — Screen Name</title>
  <!-- CDN libraries here -->
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">

  <!-- Navigation (copy across pages, do not link to a shared file) -->
  <nav data-proto-id="main-nav" class="...">...</nav>

  <!-- Page content -->
  <main data-proto-id="main-content">...</main>

</body>
</html>
```

---

## 4. Element Identification (`data-proto-id`)

Every meaningful UI element **must** carry a `data-proto-id` attribute.

```html
<nav data-proto-id="main-nav">...</nav>
<aside data-proto-id="sidebar">...</aside>
<section data-proto-id="hero-section">...</section>
<form data-proto-id="login-form">...</form>
<button data-proto-id="cta-submit">Submit</button>
<div data-proto-id="card-listing-1">...</div>
```

### Rules

1. **kebab-case** — `hero-section`, `nav-primary`, `btn-submit`
2. **Semantically meaningful** — describe what the element is
3. **Stable across iterations** — do not rename unless asked
4. **Unique per file** — no duplicates within a file
5. **Globally unique** — avoid the same ID in different pages so cross-page
   validation works
6. Apply to: sections, nav, headers, footers, forms, buttons, inputs,
   cards, modals, dialogs, and any element a reviewer might annotate

---

## 5. Multi-Page Conventions

### Navigation pattern

Repeat the navigation component verbatim in every file (no shared includes):

```html
<nav data-proto-id="main-nav" class="bg-white border-b px-6 py-3 flex items-center gap-6">
  <a href="./dashboard.html" class="font-semibold text-gray-900">App</a>
  <a href="./listings.html" class="text-gray-500 hover:text-gray-900">Listings</a>
  <a href="./settings.html" class="text-gray-500 hover:text-gray-900">Settings</a>
</nav>
```

### Active state on current page

Use a distinct Tailwind class for the active link on each page:

```html
<a href="./dashboard.html" class="font-semibold text-blue-600">Dashboard</a>
```

### Shared visual language

Use the same color palette and spacing across all pages:
- Background: `bg-gray-50`
- Cards: `bg-white rounded-xl shadow-sm border border-gray-100`
- Primary action: `bg-blue-600 hover:bg-blue-700 text-white`
- Secondary action: `border border-gray-300 hover:bg-gray-50`
- Destructive: `bg-red-600 hover:bg-red-700 text-white`

---

## 6. What Not To Do

- Do not combine multiple screens into one file
- Do not create `shared.css` or `components.html` — repeat shared elements
- Do not use absolute URLs for navigation between pages; use `./page.html`
- Do not introduce JS frameworks (React, Vue, Alpine) unless asked
- Do not remove `data-proto-id` attributes
- Do not rename existing `data-proto-id` values
