// Local ESLint rules for the warn-only AI-first report
// (eslint.config.ai-warn.mjs). Kept here instead of a third-party plugin so
// `lint:ai` needs no extra test-framework-specific dependency.
// No-op stubs for disable-comments that reference lint plugins installed in
// other toolchains (private repo security/no-secrets, editor react-hooks
// suggestions). The public repo never installed them, so without stubs the
// disable comments fail the report with "Definition for rule ... not
// found". Registered here and forced "off" in the test-hygiene blocks.
const noopRule = { create: () => ({}) };
export const legacyStubs = {
  "react-hooks": { rules: { "exhaustive-deps": noopRule } },
  security: { rules: { "detect-unsafe-regex": noopRule } },
  "no-secrets": { rules: { "no-secrets": noopRule } },
};

export default {
  rules: {
    // Warns on skipped tests (it.skip/describe.skip/xit/...) which hide
    // coverage. Focused tests (.only) stay an ERROR via core
    // no-restricted-syntax in the main config — the two severities cannot
    // share one rule key, hence this separate rule.
    "no-skipped-tests": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Prefer fixing or deleting tests over .skip — skips hide coverage.",
        },
      },
      create(context) {
        const report = (node) =>
          context.report({
            node,
            message:
              "Skipped tests hide coverage — prefer fixing or deleting over .skip.",
          });
        return {
          "CallExpression[callee.property.name='skip']": report,
          "CallExpression[callee.name=/^(xdescribe|xit|xtest)$/]": report,
        };
      },
    },
  },
};

// ── Design-system guards (P9, ticket 1d62ad83) ─────────────────────────────
// Mechanical enforcement of packages/ui/AGENTS.md ("Tokens only, no raw
// values" + "Compose on cn/cva" + "Stories"), consumed as the `ds-local`
// plugin by the error-grade block in eslint.config.mjs. Local (no new
// dependency) and purely syntactic (no type information), so the command
// stays fast. All four rules are deliberately narrow:
//
// - They inspect the documented composition points only — JSX `className`,
//   `cn`/`cva`/`clsx`/`twMerge` call arguments, and JSX `style` objects.
//   A hex inside a legacy data prop (`KanbanColumn.color: "#2563eb"`) or
//   inside an assertion (`toBe("rgb(2, 12, 27)")`) is not markup and is
//   not flagged; resolving arbitrary identifiers is out of scope.
// - `one-component-per-file` counts EXPORTED components only and skips
//   `*.stories.*` (stories multi-export by design; the story-matrix
//   manifest governs them instead).
const CLASS_HELPERS = new Set(["cn", "cva", "clsx", "twMerge"]);
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const COLOUR_FN_RE = /(^|[^\w-])(rgba?|hsla?)\s*\(/;
const ARBITRARY_VALUE_RE = /\[([^\[\]]*)\]/g;
// Bracket content that routes around the token scale: a raw colour or a
// raw dimension. Attribute-selector variants (`data-[state=open]`) do not
// match and stay allowed — they select, they do not paint.
const ARBITRARY_CONTENT_RE =
  /#[0-9a-fA-F]|rgba?\(|hsla?\(|\d\s?(px|r?em|ex|ch|%|vh|vw|vmin|vmax|pt|pc|cm|mm|in|ms|s)\b|^\s*\d/;
const COLOUR_STYLE_KEYS = new Set([
  "color",
  "background",
  "backgroundColor",
  "borderColor",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "outlineColor",
  "textDecorationColor",
  "fill",
  "stroke",
  "stopColor",
  "floodColor",
  "lightingColor",
  "caretColor",
  "columnRuleColor",
]);
// Path segments that must only ever be imported at their index/entry:
// drilling past them (`../primitives/cn`, `../src/KanbanCard`) bypasses
// the public surface. A segment in last position IS the entry
// (`../primitives`, `../src`, `@vibeflow-tools/ui/primitives`) and passes.
const INDEXED_SEGMENTS = new Set(["src", "primitives", "components"]);

// Collect every string literal + template quasi under `node` (skips
// `parent` links so the walk terminates). Returns [{ node, value }].
function collectStrings(node, out = []) {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (current.type === "Literal" && typeof current.value === "string") {
      out.push({ node: current, value: current.value });
      continue;
    }
    if (current.type === "TemplateLiteral") {
      for (const quasi of current.quasis) {
        const value = quasi.value.cooked ?? quasi.value.raw;
        if (value) out.push({ node: quasi, value });
      }
      for (const expr of current.expressions) stack.push(expr);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === "parent") continue;
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
  return out;
}

function containsJSX(node) {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (
      current.type === "JSXElement" ||
      current.type === "JSXFragment"
    ) {
      return true;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === "parent") continue;
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
  return false;
}

function isComponentName(name) {
  return typeof name === "string" && /^[A-Z]/.test(name);
}

// Class-string positions: JSX `className`/`class` attributes and
// `cn`/`cva`/`clsx`/`twMerge(...)` call arguments. Reports each offending
// string once via `report(value, node)`.
function checkClassStrings(node, sourceCode, report) {
  if (
    node.type === "JSXAttribute" &&
    node.name.type === "JSXIdentifier" &&
    (node.name.name === "className" || node.name.name === "class")
  ) {
    const value = node.value;
    if (!value) return;
    if (value.type === "Literal" && typeof value.value === "string") {
      report(value.value, value);
    } else if (value.type === "JSXExpressionContainer") {
      for (const { node: n, value: v } of collectStrings(value.expression)) {
        report(v, n);
      }
    }
    return;
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    CLASS_HELPERS.has(node.callee.name)
  ) {
    for (const arg of node.arguments) {
      if (arg.type === "SpreadElement") continue;
      for (const { node: n, value: v } of collectStrings(arg)) {
        report(v, n);
      }
    }
  }
}

export const designSystem = {
  rules: {
    // P9 rule 1 — no raw colour values in component markup/styles.
    "no-raw-colours": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Design-system tokens only: no hex / rgb() literals in className, cn/cva/clsx calls, or JSX style colour values.",
        },
      },
      create(context) {
        const reportRaw = (value, node) => {
          const hit = value.match(HEX_RE) ?? value.match(COLOUR_FN_RE);
          if (hit) {
            context.report({
              node,
              message:
                `ds-no-raw-colours: raw colour value "${hit[0].trim()}" — use a token utility from src/primitives/theme.css (packages/ui/AGENTS.md "Tokens only").`,
            });
          }
        };
        return {
          JSXAttribute(node) {
            checkClassStrings(node, context.sourceCode, reportRaw);
            if (
              node.name.type !== "JSXIdentifier" ||
              node.name.name !== "style" ||
              node.value?.type !== "JSXExpressionContainer" ||
              node.value.expression.type !== "ObjectExpression"
            ) {
              return;
            }
            for (const prop of node.value.expression.properties) {
              if (prop.type !== "Property") continue;
              const key =
                prop.key.type === "Identifier"
                  ? prop.key.name
                  : prop.key.type === "Literal"
                    ? String(prop.key.value)
                    : null;
              for (const { node: n, value: v } of collectStrings(prop.value)) {
                if (HEX_RE.test(v) || COLOUR_FN_RE.test(v)) {
                  context.report({
                    node: n,
                    message:
                      `ds-no-raw-colours: raw colour value in style.${key ?? "?"} — use a token utility from src/primitives/theme.css (packages/ui/AGENTS.md "Tokens only").`,
                  });
                } else if (
                  key !== null &&
                  COLOUR_STYLE_KEYS.has(key) &&
                  prop.value.type === "Literal"
                ) {
                  // Named colours (`color: "red"`) carry no hex but break
                  // the six-theme sweep exactly the same way.
                  context.report({
                    node: n,
                    message:
                      `ds-no-raw-colours: named colour "${v}" in style.${key} — use a token utility from src/primitives/theme.css (packages/ui/AGENTS.md "Tokens only").`,
                  });
                }
              }
            }
          },
          CallExpression(node) {
            checkClassStrings(node, context.sourceCode, reportRaw);
          },
        };
      },
    },
    // P9 rule 2 — no arbitrary Tailwind values (`w-[137px]`, `bg-[#fff]`).
    "no-arbitrary-tailwind": {
      meta: {
        type: "problem",
        docs: {
          description:
            "No arbitrary Tailwind values in class strings: a missing utility means a missing token — add it to theme.css.",
        },
      },
      create(context) {
        const reportArbitrary = (value, node) => {
          ARBITRARY_VALUE_RE.lastIndex = 0;
          let match;
          while ((match = ARBITRARY_VALUE_RE.exec(value)) !== null) {
            if (ARBITRARY_CONTENT_RE.test(match[1])) {
              context.report({
                node,
                message:
                  `ds-no-arbitrary-tailwind: arbitrary Tailwind value "[${match[1]}]" — add a token to src/primitives/theme.css instead (packages/ui/AGENTS.md "Tokens only").`,
              });
              return;
            }
          }
        };
        return {
          JSXAttribute(node) {
            checkClassStrings(node, context.sourceCode, reportArbitrary);
          },
          CallExpression(node) {
            checkClassStrings(node, context.sourceCode, reportArbitrary);
          },
        };
      },
    },
    // P9 rule 3 — no deep imports past an index/entry.
    "no-deep-imports": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Import the primitives index, the package entry, or a declared subpath — never a …/src/… or primitives/<file> path.",
        },
      },
      create(context) {
        const checkSource = (sourceNode) => {
          if (!sourceNode || sourceNode.type !== "Literal") return;
          const specifier =
            typeof sourceNode.value === "string" ? sourceNode.value : null;
          if (!specifier) return;
          const segments = specifier.split("/");
          for (let i = 0; i < segments.length - 1; i++) {
            if (INDEXED_SEGMENTS.has(segments[i])) {
              context.report({
                node: sourceNode,
                message:
                  `ds-no-deep-imports: deep import "${specifier}" — import the primitives index ("../primitives"), the package entry ("../src"), or a declared subpath instead (packages/ui/AGENTS.md "Compose on cn / cva").`,
              });
              return;
            }
          }
        };
        return {
          ImportDeclaration(node) {
            checkSource(node.source);
          },
          ExportNamedDeclaration(node) {
            if (node.source) checkSource(node.source);
          },
          ExportAllDeclaration(node) {
            checkSource(node.source);
          },
        };
      },
    },
    // P9 rule 4 — one component per file (single-file components).
    // Counts EXPORTED components (Uppercase function/class/arrow containing
    // JSX, including `export default`); unexported helpers and non-JSX
    // exports (styles, types, STORY_MATRIX) never count. `*.stories.*`
    // files are exempt — stories multi-export by design and the
    // story-matrix manifest governs them instead.
    "one-component-per-file": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Single-file components: at most one exported component per file.",
        },
      },
      create(context) {
        if (/\.stories\.[jt]sx?$/.test(context.filename)) return {};
        const exported = [];
        const pushIfComponent = (name, bodyNode, reportNode) => {
          if (isComponentName(name) && bodyNode && containsJSX(bodyNode)) {
            exported.push({ name, node: reportNode });
          }
        };
        return {
          ExportNamedDeclaration(node) {
            const decl = node.declaration;
            if (!decl) return; // `export { X }` / `export { X } from` — no JSX here.
            if (
              decl.type === "FunctionDeclaration" ||
              decl.type === "ClassDeclaration"
            ) {
              pushIfComponent(decl.id?.name, decl.body, node);
            } else if (decl.type === "VariableDeclaration") {
              for (const d of decl.declarations) {
                if (
                  d.id.type === "Identifier" &&
                  d.init &&
                  (d.init.type === "ArrowFunctionExpression" ||
                    d.init.type === "FunctionExpression")
                ) {
                  pushIfComponent(d.id.name, d.init.body, node);
                }
              }
            }
          },
          ExportDefaultDeclaration(node) {
            const decl = node.declaration;
            if (!decl) return;
            if (
              decl.type === "FunctionDeclaration" ||
              decl.type === "ClassDeclaration"
            ) {
              pushIfComponent(decl.id?.name ?? "default", decl.body, node);
            } else if (
              decl.type === "ArrowFunctionExpression" ||
              decl.type === "FunctionExpression"
            ) {
              pushIfComponent("default", decl.body, node);
            }
          },
          "Program:exit"() {
            for (const extra of exported.slice(1)) {
              context.report({
                node: extra.node,
                message:
                  `ds-one-component-per-file: second exported component "${extra.name}" in one file — split into single-file components (packages/ui/AGENTS.md).`,
              });
            }
          },
        };
      },
    },
  },
};
