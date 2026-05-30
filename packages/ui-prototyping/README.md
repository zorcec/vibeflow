# @vibeflow-tools/ui-prototyping

> **In-app variant switching for React** — page-level and component-level prototyping with URL persistence and zero runtime dependencies.

[![npm](https://img.shields.io/npm/v/@vibeflow-tools/ui-prototyping)](https://www.npmjs.com/package/@vibeflow-tools/ui-prototyping)

```bash
npm install @vibeflow-tools/ui-prototyping
```

---

## Why It Matters

Designing and reviewing UI variations is slow when you have to change code, rebuild, and refresh every time you want to see a different state. `ui-prototyping` brings the switch directly into your running app:

- **Click to switch** — numbered dot on each component, floating toolbar for all scopes at once
- **URL-persisted** — share a URL and your reviewer sees the exact variant you're showing them
- **TypeScript-first** — variant keys are narrowed to their literal types, config objects are fully typed
- **Zero runtime deps** — peer-deps only (`react`, `react-dom`); nothing extra in your bundle
- **Vibeflow overlay integration** — when the Vibeflow overlay is detected, the toolbar is accessible via the right-click context menu ("Prototyping" option)

---

## Quick Start

```tsx
import { VariantProvider, useVariant, PageVariantSwitcher } from '@vibeflow-tools/ui-prototyping'

// 1. Define your variants
const heroVariants = {
  default:  {},
  compact:  { spacing: 'tight', titleSize: 'md' },
  expanded: { spacing: 'loose', titleSize: 'xl' },
}

// 2. Read the active variant
function HeroSection() {
  const v = useVariant('Hero', heroVariants)
  return (
    <section className={v.spacing === 'tight' ? 'py-4' : 'py-12'}>
      <PageVariantSwitcher name="Hero" variants={heroVariants} />
      <h1 className={v.titleSize === 'xl' ? 'text-4xl' : 'text-2xl'}>Welcome</h1>
    </section>
  )
}

// 3. Wrap your app
function App() {
  return (
    <VariantProvider>
      <HeroSection />
    </VariantProvider>
  )
}
```

---

## Installation

```bash
npm install @vibeflow-tools/ui-prototyping
# or
pnpm add @vibeflow-tools/ui-prototyping
# or
yarn add @vibeflow-tools/ui-prototyping
```

**Requirements:** React 18+, Node.js 18+.

---

## Core API

### `<VariantProvider>`

Wrap your app (or a subtree) with `VariantProvider` to enable the variant switching system. All hooks and switcher components below it share state via this provider.

```tsx
<VariantProvider>
  <App />
</VariantProvider>
```

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `mode` | `"dev" \| "always"` | `"dev"` | `"dev"` hides switcher UI in production (`NODE_ENV === "production"`). `"always"` always shows it — useful for A/B testing demos. |
| `defaultVisible` | `boolean` | `true` | Initial UI visibility. Persisted in `localStorage` so users can hide/show across sessions. |
| `shortcuts` | `KeyboardShortcut[] \| false` | default shortcuts | Custom keyboard shortcuts for toggling the variant UI. Pass `false` to disable. |

---

### `useVariant(name, variants)`

Core hook. Registers the scope, resolves the active variant from URL → localStorage → default, and returns the matching config object.

```tsx
const variants = {
  default:  {},
  compact:  { compact: true, density: 'low' },
  detailed: { showMeta: true, showComments: true },
}

function TaskCard() {
  const v = useVariant('TaskCard', variants)
  // v is typed as typeof variants[keyof typeof variants]
  return <div className={v.compact ? 'p-2' : 'p-4'}>…</div>
}
```

The first key is always the default variant (applied when no URL param or storage entry is present).

---

### `<VariantSwitcher>`

A subtle indicator dot positioned on the edge of the parent element. Clicking it expands a numbered-dots picker.

```tsx
function TaskCard() {
  const v = useVariant('TaskCard', variants)
  return (
    <div style={{ position: 'relative' }}>
      <VariantSwitcher name="TaskCard" variants={variants} />
      {v.compact ? <CompactView /> : <FullView />}
    </div>
  )
}
```

**The parent must have `position: relative` for correct placement.**

Deduplicates per scope — only the first `VariantSwitcher` for a given scope renders, even if the component is used multiple times on the page.

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `name` | `string` | required | Scope name — must match the `useVariant` call |
| `variants` | `Record<string, object>` | required | Same variant definitions passed to `useVariant` |
| `position` | `"right" \| "left"` | `"right"` | Which side the dot appears on |

---

### `<PageVariantSwitcher>`

A dark segmented control fixed to the top-left of the viewport — ideal for page-level layout or theme switching.

```tsx
function DashboardPage() {
  const layout = useVariant('DashboardLayout', layoutVariants)
  return (
    <>
      <PageVariantSwitcher name="DashboardLayout" variants={layoutVariants} />
      <main className={layout.sidebar ? 'with-sidebar' : ''}>…</main>
    </>
  )
}
```

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `name` | `string` | required | Scope name — must match the `useVariant` call |
| `variants` | `Record<string, object>` | required | Same variant definitions passed to `useVariant` |

---

### `<VariantDevToolbar>`

An optional floating toolbar that shows **all registered variant scopes** at once in a single panel. Use this when you have many scopes and want a central control panel.

```tsx
function App() {
  return (
    <VariantProvider>
      <VariantDevToolbar />  {/* ← add once near the root */}
      <MainContent />
    </VariantProvider>
  )
}
```

The toolbar button (`⚡`) appears bottom-right of the page. When the Vibeflow overlay is detected, the button is hidden — access the toolbar instead via the overlay's right-click context menu.

**Keyboard shortcuts:**
- `Alt+H` — toggle all switchers on/off
- `Ctrl+Shift+V` — toggle all switchers on/off
- `Escape` — close the toolbar panel

---

### `registerVariant(name, variants)`

Module-level registration. Use this to centralise all variant definitions in one file instead of re-passing them to every component.

```ts
// variants.ts
import { registerVariant } from '@vibeflow-tools/ui-prototyping'

registerVariant('TaskCard', {
  default:  {},
  minimal:  { compact: true },
  detailed: { showMeta: true, showComments: true },
})

registerVariant('KanbanBoard', {
  default: {},
  dense:   { rowHeight: 'sm' },
})
```

```tsx
// TaskCard.tsx
function TaskCard() {
  // Pass an empty object — registered variants are merged automatically
  const v = useVariant('TaskCard', {})
  return <div className={v.compact ? 'p-2' : 'p-4'}>…</div>
}
```

Inline variants always win over registered ones when both are provided.

---

## Persistence

Active variants are persisted in two places:

| Layer | Storage | Scope |
|-------|---------|-------|
| URL param | `?vf-<name>=<variant>` | Shareable — copy the URL to share a specific variant |
| localStorage | `vf-<name>` | Session — survives page reloads in the same browser |

URL takes precedence over localStorage.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+H` | Toggle all variant switchers on/off |
| `Ctrl+Shift+V` | Toggle all variant switchers on/off |

Both shortcuts call `toggleUiVisible()` on the `VariantProvider`. To open the `VariantDevToolbar` panel, click the `⚡` button in the bottom-right corner.

Customise or disable shortcuts via the `shortcuts` prop on `VariantProvider`:

```tsx
// Custom shortcuts
<VariantProvider shortcuts={[{ key: 'v', alt: true }]}>
  <App />
</VariantProvider>

// Disable all shortcuts
<VariantProvider shortcuts={false}>
  <App />
</VariantProvider>
```

---

## Vibeflow Overlay Integration

When the [Vibeflow](https://vibeflow.tools) overlay is injected into the page, `VariantDevToolbar` automatically hides its standalone `⚡` button and registers itself with the overlay. The toolbar is then accessible via the overlay's right-click context menu under **"Prototyping"**.

No configuration needed — detection is automatic.

---

## Advanced: Power User Utilities

The following URL/localStorage utilities are exported for cases where you need manual control:

```ts
import {
  readVariantFromUrl,
  writeVariantToUrl,
  removeVariantFromUrl,
  readVariantFromStorage,
  writeVariantToStorage,
  removeVariantFromStorage,
  resolveActiveVariant,
  readUiVisibleFromStorage,
  writeUiVisibleToStorage,
} from '@vibeflow-tools/ui-prototyping'
```

---

## TypeScript

All exports are fully typed. The `useVariant` hook preserves key-literal types so your IDE autocompletes variant config properties:

```tsx
const variants = {
  default: {},
  compact: { compact: true as const, rows: 3 as const },
}

function MyComponent() {
  const v = useVariant('MyComponent', variants)
  // v.compact is typed as `true | undefined`
  // v.rows is typed as `3 | undefined`
}
```

---

## Contributing

```bash
pnpm install
pnpm --filter @vibeflow-tools/ui-prototyping run build
pnpm --filter @vibeflow-tools/ui-prototyping run test
pnpm --filter @vibeflow-tools/ui-prototyping run test:coverage
```

---

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) — see [NOTICE](https://github.com/zorcec/vibeflow/blob/main/NOTICE) for third-party attributions.
