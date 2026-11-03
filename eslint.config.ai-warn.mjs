// Warn-only AI-first conventions report — NEVER wire into pre-push/check/lint
// without owner sign-off (ticket pqojj4zas2acooidf7xu72dm, Step 1 of the plan).
// This config must always exit 0: every rule below is "warn" except focused
// tests (.only), which are "error" because they silently break other lanes'
// suites. The existing `lint:symbols` + `tsc --noEmit` gates stay byte-identical.
import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";
import localRules, { legacyStubs } from "./eslint.local-rules.mjs";

const kanbanExclusion =
  // WHY: a concurrent lane is actively editing packages/ui/src/kanban/**
  // (drag-and-drop outage regression). Keep this report off those files until
  // the DnD fix lands — same exclusion as eslint.config.mjs.
  // TODO(699091163803a4ef94ca5fb974c93a): remove this exclude once the DnD fix lands.
  "packages/ui/src/kanban/**";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.stryker-tmp/**",
      "**/.next/**",
      "**/*.gen.ts",
      "**/overlay-bundle.gen.ts",
      kanbanExclusion,
    ],
  },
  // ── Type-aware AI-discipline rules (warn) ──────────────────────────────
  // projectService auto-discovers the per-package tsconfigs; allowDefaultProject
  // covers tool/config files outside any tsconfig include.
  {
    files: ["packages/*/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        projectService: {
          allowDefaultProject: ["*.config.ts", "*.config.mjs"],
        },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "import-x": importX,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-floating-promises": "warn",
      "import-x/order": [
        "warn",
        {
          alphabetize: { order: "asc", caseInsensitive: true },
          "newlines-between": "ignore",
        },
      ],
      "no-duplicate-imports": "warn",
      complexity: ["warn", 15],
      "max-depth": ["warn", 4],
      "max-params": ["warn", 4],
      "max-lines": [
        "warn",
        {
          max: 500,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
    },
  },
  // ── no-console (warn, allow warn/error) for client-side code only ──────
  // Server code legitimately logs; browser/client code should not.
  {
    files: [
      "packages/*/src/client/**/*.{ts,tsx}",
      "packages/ui/src/**/*.{ts,tsx}",
    ],
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  // ── Test hygiene: .only is ERROR, .skip is warn ────────────────────────
  // Focused tests silently skip other lanes' suites in shared runs.
  {
    files: [
      "packages/*/src/**/*.{test,spec}.{ts,tsx}",
      "packages/*/tests/**/*.{ts,tsx}",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    linterOptions: {
      // Stale cross-toolchain disables (see legacyStubs) resolve to "off"
      // rules below — don't nag about them being unused in this report.
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      ...legacyStubs,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-var-requires": "off",
      "react-hooks/exhaustive-deps": "off",
      "security/detect-unsafe-regex": "off",
      "no-secrets/no-secrets": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='only'], CallExpression[callee.name=/^(fdescribe|fit)$/]",
          message:
            "Focused tests (.only/fdescribe/fit) break other lanes' suites — remove before commit.",
        },
      ],
    },
  },
  {
    files: [
      "packages/*/src/**/*.{test,spec}.{ts,tsx}",
      "packages/*/tests/**/*.{ts,tsx}",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      local: localRules,
      "@typescript-eslint": tseslint.plugin,
      ...legacyStubs,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-var-requires": "off",
      "react-hooks/exhaustive-deps": "off",
      "security/detect-unsafe-regex": "off",
      "no-secrets/no-secrets": "off",
      "local/no-skipped-tests": "warn",
    },
  },
];
