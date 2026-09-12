// Minimal lint config: one rule — unused symbols. No presets, no style rules.
// Motivation: `tsc --noEmit` (the repo's only prior gate) does not flag unused
// imports/locals, and `tsc` cannot exclude imported files, so a file-scoped
// linter is required to run the rule everywhere except the excluded path below.
import tseslint from "typescript-eslint";

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
];
