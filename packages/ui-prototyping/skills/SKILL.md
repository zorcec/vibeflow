---
name: ui-prototyping
description: Use when building, reviewing, or integrating @vibeflow-tools/ui-prototyping — in-app variant switching for React. Triggers on "useVariant", "PageVariantSwitcher", "VariantSwitcher", "VariantProvider", "variant switching", "prototyping components", "A/B testing variants", "design variants".
---

# @vibeflow-tools/ui-prototyping

In-app variant switching for React — page-level layout changes and component-level density/style changes with URL persistence and zero runtime dependencies.

## When to Use

- **Design review** — switch between layout variants without code changes
- **A/B testing** — persist variant selection across sessions
- **Component documentation** — show all variants in a live playground
- **Prototyping** — quickly test different UI approaches

## Quick Setup

```tsx
import {
  VariantProvider,
  useVariant,
  PageVariantSwitcher,
  VariantSwitcher,
  VariantDevToolbar,
} from '@vibeflow-tools/ui-prototyping'

function App() {
  return (
    <VariantProvider>
      <VariantDevToolbar />   {/* ⚡ floating button, bottom-right */}
      <PageVariantSwitcher name="Layout" variants={layoutVariants} />
      <YourApp />
    </VariantProvider>
  )
}
```

## Core Concepts

### Scopes

A **scope** is a named group of variants. Use PascalCase component names:

```tsx
// ✅ Good — descriptive, matches component
useVariant('TaskCard', { default: {}, compact: {} })
useVariant('KanbanBoard', { columns: {}, swimlane: {} })

// ❌ Bad — generic, unclear intent
useVariant('variant1', { a: {}, b: {} })
useVariant('test', { light: {}, dark: {} })
```

### Variant Resolution Order

1. **URL param** — `?vf[ScopeName]=variant` (highest priority, shareable)
2. **localStorage** — `__vf__ScopeName` (persists across sessions)
3. **Default** — first key in the variants object

### Two Switcher Levels

| Level | Component | Visual | Use Case |
|-------|-----------|--------|----------|
| **Page** | `PageVariantSwitcher` | Dark segmented bar, top-left | Layout changes (columns ↔ swimlane) |
| **Component** | `VariantSwitcher` | Subtle dot → click to expand | Density changes (default ↔ compact) |

## Components

### VariantProvider

Wraps your app (or subtree) and provides the variant system.

```tsx
<VariantProvider mode="dev" defaultVisible={true}>
  {children}
</VariantProvider>
```

| Prop | Default | Description |
|------|---------|-------------|
| `mode` | `"dev"` | `"dev"` — hidden in production; `"always"` — always visible |
| `defaultVisible` | `true` | Initial visibility state |

### useVariant

Core hook — returns the active variant config object.

```tsx
const variants = {
  default: { padding: 16, showMeta: true },
  compact: { padding: 8, showMeta: false },
  detailed: { padding: 24, showMeta: true, showComments: true },
}

function TaskCard() {
  const variant = useVariant('TaskCard', variants)
  return <div style={{ padding: variant.padding }}>...</div>
}
```

**Returns:** The config object for the active variant. First key is default.

### PageVariantSwitcher

Dark segmented bar for page-level layout switching. Fixed top-left, always visible when UI is shown.

```tsx
const layoutVariants = {
  columns: { direction: 'row' },
  swimlane: { direction: 'column' },
  compact: { direction: 'row', dense: true },
}

function App() {
  const layout = useVariant('App', layoutVariants)
  return (
    <>
      <PageVariantSwitcher name="App" variants={layoutVariants} />
      <div className={`layout-${layout.direction}`}>
        {/* content */}
      </div>
    </>
  )
}
```

### VariantSwitcher

Subtle indicator dot for component-level switching. A small dot appears on the right (or left) side — click to expand the numbered-dots picker. Click outside or press Escape to collapse.

```tsx
function TaskCard({ task }) {
  const variant = useVariant('TaskCard', cardVariants)
  return (
    <div style={{ position: 'relative' }}>
      <VariantSwitcher name="TaskCard" variants={cardVariants} />
      <div className={variant.compact ? 'compact' : ''}>
        {/* card content */}
      </div>
    </div>
  )
}
```

**Dedup:** Only one `VariantSwitcher` per scope renders. Multiple components using the same scope share one switcher.

**UX:** Small dot (14px) → click → numbered dots appear → select variant → collapses back to dot.

### VariantDevToolbar

Floating ⚡ button (bottom-right) that opens a dialog showing all active scopes and their current variants.

**Vibeflow overlay integration:** When the Vibeflow overlay is detected (`#vibeflow-studio-root`), the standalone ⚡ button is hidden. Instead, access the toolbar via the overlay's right-click context menu → "Prototyping".

```tsx
<VariantProvider>
  <VariantDevToolbar />
  {/* your app */}
</VariantProvider>
```

### registerVariant

Pre-register variants before the React tree (module-level).

```tsx
import { registerVariant } from '@vibeflow-tools/ui-prototyping'

// Call before any component renders
registerVariant('TaskCard', {
  default: {},
  compact: { compact: true },
  detailed: { showMeta: true },
})
```

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt + H` | Toggle all switchers visibility |
| `Ctrl + Shift + V` | Toggle dev toolbar |

## Patterns

### Pattern A: Page Layout Switching

One switcher controls the entire page layout.

```tsx
const layoutVariants = {
  columns: { direction: 'row', gap: 16 },
  sidebar: { direction: 'row', sidebar: true, gap: 24 },
  mobile: { direction: 'column', gap: 8 },
}

function App() {
  const layout = useVariant('App', layoutVariants)
  return (
    <>
      <PageVariantSwitcher name="App" variants={layoutVariants} />
      <div style={{ display: 'flex', flexDirection: layout.direction, gap: layout.gap }}>
        {layout.sidebar && <Sidebar />}
        <Main />
      </div>
    </>
  )
}
```

### Pattern B: Component Density Switching

Multiple components share one scope — all switch together.

```tsx
const cardVariants = {
  default: {},
  compact: { compact: true },
  detailed: { showMeta: true, showComments: true },
}

function TaskCard({ task }) {
  const variant = useVariant('TaskCard', cardVariants)
  return (
    <div style={{ position: 'relative' }}>
      <VariantSwitcher name="TaskCard" variants={cardVariants} />
      <div className={variant.compact ? 'compact' : ''}>
        <h3>{task.title}</h3>
        {variant.showMeta && <span>{task.assignee}</span>}
        {variant.showComments && <CommentList comments={task.comments} />}
      </div>
    </div>
  )
}
```

All `TaskCard` instances share one switcher — change one, all update.

### Pattern C: Multiple Independent Scopes

Different components have independent variant states.

```tsx
function App() {
  return (
    <VariantProvider>
      <VariantDevToolbar />
      <PageVariantSwitcher name="Layout" variants={layoutVariants} />
      <Sidebar />
      <Main />
    </VariantProvider>
  )
}

function Sidebar() {
  const variant = useVariant('Sidebar', {
    expanded: { width: 280 },
    collapsed: { width: 64 },
  })
  return (
    <aside style={{ width: variant.width, position: 'relative' }}>
      <VariantSwitcher name="Sidebar" variants={sidebarVariants} />
      {/* sidebar content */}
    </aside>
  )
}
```

### Pattern D: Conditional Rendering

Variants control which features are visible.

```tsx
function Dashboard() {
  const variant = useVariant('Dashboard', {
    default: { showCharts: true, showTable: true, showStats: true },
    analytics: { showCharts: true, showTable: true, showStats: false },
    minimal: { showCharts: false, showTable: true, showStats: false },
  })

  return (
    <>
      <PageVariantSwitcher name="Dashboard" variants={dashboardVariants} />
      {variant.showStats && <StatsBar />}
      {variant.showCharts && <Charts />}
      {variant.showTable && <DataTable />}
    </>
  )
}
```

### Pattern E: Shareable URLs

Variant state is synced to URL automatically — share the link.

```
https://myapp.com/dashboard?vf[Layout]=sidebar&vf[TaskCard]=compact
```

Team members opening this link see the exact same variant configuration.

## Best Practices

### Do

- ✅ Use PascalCase scope names matching component names
- ✅ Keep variant configs flat (no nesting)
- ✅ Use boolean flags for feature toggles: `{ compact: true }`
- ✅ Use string enums for modes: `{ layout: 'grid' }`
- ✅ Place `PageVariantSwitcher` outside content flow (fixed positioning)
- ✅ Place `VariantSwitcher` inside `position: relative` parent
- ✅ Place one `VariantSwitcher` per section (dedup handles the rest)
- ✅ Let `VariantSwitcher` deduplicate — don't manually control visibility

### Don't

- ❌ Nest variant configs: `{ style: { padding: 16 } }` — use flat: `{ padding: 16 }`
- ❌ Use generic scope names: `variant1`, `test`, `foo`
- ❌ Place multiple `PageVariantSwitcher` for the same scope
- ❌ Place `VariantSwitcher` on every item — one per section, dedup handles it
- ❌ Skip `VariantProvider` — all hooks require it

## Vibeflow Overlay Integration

When both `@vibeflow-tools/ui-prototyping` and the Vibeflow overlay are present on the same page:

1. **Detection:** `VariantDevToolbar` detects the overlay via `#vibeflow-studio-root`
2. **Hiding:** The standalone ⚡ button is hidden (no duplicate bottom-right icons)
3. **Registration:** The toolbar registers on `window.__vf_prototyping` with `openPanel()` / `closePanel()` methods
4. **Overlay menu:** The overlay's right-click context menu gains a "Prototyping" option
5. **Opening:** Clicking "Prototyping" calls `window.__vf_prototyping.openPanel()`

**No configuration needed** — integration is automatic via runtime detection.

## Troubleshooting

### Switcher not visible

1. Check `mode` prop on `VariantProvider` — `"dev"` hides in production
2. Check `uiVisible` state — press `Alt + H` to toggle
3. Check variant count — switchers need 2+ variants
4. Check if indicator dot is present (small 14px dot on the right side)

### Variant not updating

1. Verify scope name matches between `useVariant` and switcher
2. Check URL params — they override localStorage
3. Clear localStorage: `localStorage.removeItem('__vf__ScopeName')`

### Multiple switchers appearing

This is expected if you're using the demo (vanilla JS). In React, `VariantSwitcher` deduplicates automatically — only one renders per scope.

### Indicator dot not expanding

Click the dot to expand the picker. Click outside or press Escape to collapse. The picker is not hover-based — it requires a click.

## API Reference

| Export | Type | Description |
|--------|------|-------------|
| `VariantProvider` | Component | Root provider — wraps app |
| `useVariant` | Hook | Returns active variant config |
| `PageVariantSwitcher` | Component | Dark bar, top-left |
| `VariantSwitcher` | Component | Numbered dots, hover reveal |
| `VariantDevToolbar` | Component | Floating ⚡ button + dialog |
| `registerVariant` | Function | Pre-register variants at module level |
| `getRegisteredVariant` | Function | Read registered variants |
| `clearVariantRegistry` | Function | Reset registry (testing) |
| `useKeyboardShortcuts` | Hook | Bind Alt+H / Ctrl+Shift+V |
| `useVariantContext` | Hook | Access raw context (power users) |

### URL/localStorage Utils (Power Users)

| Export | Description |
|--------|-------------|
| `readVariantFromUrl` | Read `?vf[Name]` from URL |
| `writeVariantToUrl` | Write variant to URL |
| `removeVariantFromUrl` | Remove variant from URL |
| `readVariantFromStorage` | Read `__vf__Name` from localStorage |
| `writeVariantToStorage` | Write variant to localStorage |
| `removeVariantFromStorage` | Remove variant from localStorage |
| `resolveActiveVariant` | Resolve: URL → localStorage → default |
