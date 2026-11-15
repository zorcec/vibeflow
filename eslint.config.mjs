// Minimal lint config: one rule — unused symbols. No presets, no style rules.
// Motivation: `tsc --noEmit` (the repo's only prior gate) does not flag unused
// imports/locals, and `tsc` cannot exclude imported files, so a file-scoped
// linter is required to run the rule everywhere except the excluded path below.
import tseslint from "typescript-eslint";
import { designSystem } from "./eslint.local-rules.mjs";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.stryker-tmp/**",
      // WHY: a concurrent P1 worker is actively editing packages/ui/src/kanban/**
      // (drag-and-drop outage regression) in the same working tree. Excluding it
      // keeps two writers off those files; `tsc` would otherwise pull the whole
      // subtree in via imports and report its pre-existing unused symbols.
      // TODO(699091163803a4ef94ca5fb974c93a): remove this exclude once the DnD
      // fix has landed — it currently hides 12 source + 6 test unused symbols
      // (unused React imports in ChildPopover/FileItem/TagPills; unused
      // isInline/onSave/_typeColor/bg/index/taskId/isAdd params; unused
      // TASK_TYPE_ICONS import in components/TaskCard.tsx).
      "packages/ui/src/kanban/**",
    ],
  },
  {
    files: ["packages/*/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // ── Design-system guards (P9) ─────────────────────────────────────────
  // SCOPE DECISION (P9, same shape as the coverage gate in
  // packages/ui/vitest.config.ts): the four `ds-local/*` rules cover the
  // design-system surface — what the rebuild actually writes — not the
  // legacy tree (src root, src/kanban) this effort exists to delete. The
  // legacy components use inline styles and deep cross-imports everywhere
  // (measured: StatusBadge-style `style={{…}}` colour literals,
  // `../src/…` story imports before P9 fixed the design-system ones); a
  // repo-wide rule would be red on day one and get disabled. P16/P17 widen
  // this `files` list once the legacy tree is gone — that widening is part
  // of P17's exit criteria, not an afterthought.
  {
    files: [
      "packages/ui/src/primitives/**/*.{ts,tsx}",
      "packages/ui/src/components/**/*.{ts,tsx}",
      "packages/ui/src/templates/**/*.{ts,tsx}",
      "packages/ui/stories/**/*.{ts,tsx}",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "ds-local": designSystem,
    },
    rules: {
      "ds-local/no-raw-colours": "error",
      "ds-local/no-arbitrary-tailwind": "error",
      "ds-local/no-deep-imports": "error",
      "ds-local/one-component-per-file": "error",
    },
  },
];
