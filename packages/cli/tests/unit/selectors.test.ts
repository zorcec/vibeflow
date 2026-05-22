// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  buildCssSelector,
  buildSourcePointer,
  buildSourcePointerAsync,
  formatSourcePointerForAgent,
  isDirectSourceUrl,
  captureV8CallSites,
  resolveDirectSourceFromStack,
} from "../../src/client/overlay-browser/selectors.js";

// ── buildCssSelector ──────────────────────────────────────────────────────────

describe("buildCssSelector", () => {
  it("returns the tag name for a bare element with no parent class or id", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(buildCssSelector(div)).toBe("div");
    document.body.removeChild(div);
  });

  it("includes up to 2 stable classes, skips hashed class names", () => {
    const div = document.createElement("div");
    div.classList.add("my-class", "abc12345", "other-class", "xyz99999");
    document.body.appendChild(div);
    const sel = buildCssSelector(div);
    expect(sel).toContain("my-class");
    expect(sel).toContain("other-class");
    expect(sel).not.toContain("abc12345");
    document.body.removeChild(div);
  });

  it("skips vibeflow- prefixed classes", () => {
    const div = document.createElement("div");
    div.classList.add("vibeflow-sidebar", "real-class");
    document.body.appendChild(div);
    const sel = buildCssSelector(div);
    expect(sel).not.toContain("vibeflow-sidebar");
    expect(sel).toContain("real-class");
    document.body.removeChild(div);
  });

  it("adds nth-child when siblings share the same tag", () => {
    const parent = document.createElement("div");
    const child1 = document.createElement("span");
    const child2 = document.createElement("span");
    parent.appendChild(child1);
    parent.appendChild(child2);
    document.body.appendChild(parent);
    const sel = buildCssSelector(child2);
    expect(sel).toContain("nth-child(2)");
    document.body.removeChild(parent);
  });

  it("omits nth-child when the element is a unique sibling tag", () => {
    const parent = document.createElement("div");
    const child = document.createElement("h1");
    const sibling = document.createElement("p");
    parent.appendChild(child);
    parent.appendChild(sibling);
    document.body.appendChild(parent);
    const sel = buildCssSelector(child);
    expect(sel).not.toContain("nth-child");
    document.body.removeChild(parent);
  });

  it("anchors to semantic id on an ancestor (stops traversal)", () => {
    const parent = document.createElement("div");
    parent.id = "main-content";
    const child = document.createElement("p");
    parent.appendChild(child);
    document.body.appendChild(parent);
    const sel = buildCssSelector(child);
    expect(sel).toBe("#main-content > p");
    document.body.removeChild(parent);
  });

  it("skips auto-generated UUID-like ids", () => {
    const div = document.createElement("div");
    div.id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    document.body.appendChild(div);
    const sel = buildCssSelector(div);
    expect(sel).not.toContain("#a1b2c3d4");
    document.body.removeChild(div);
  });

  it("skips numeric-only ids", () => {
    const div = document.createElement("div");
    div.id = "123456";
    document.body.appendChild(div);
    expect(buildCssSelector(div)).not.toContain("#123456");
    document.body.removeChild(div);
  });

  it("caps depth at 6 levels", () => {
    let node: HTMLElement = document.body;
    const roots: HTMLElement[] = [];
    for (let i = 0; i < 8; i++) {
      const child = document.createElement("div");
      node.appendChild(child);
      if (i === 0) roots.push(child);
      node = child;
    }
    const sel = buildCssSelector(node);
    expect(sel.split(" > ").length).toBeLessThanOrEqual(6);
    roots.forEach(r => document.body.removeChild(r));
  });

  it("anchors to ancestor data-testid (stops traversal)", () => {
    const parent = document.createElement("section");
    parent.setAttribute("data-testid", "user-profile");
    const child = document.createElement("button");
    parent.appendChild(child);
    document.body.appendChild(parent);
    const sel = buildCssSelector(child);
    expect(sel).toContain('[data-testid="user-profile"]');
    document.body.removeChild(parent);
  });
});

// ── buildSourcePointer ────────────────────────────────────────────────────────

describe("buildSourcePointer", () => {
  it("always returns a selector", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const p = buildSourcePointer(div);
    expect(typeof p.selector).toBe("string");
    expect(p.selector.length).toBeGreaterThan(0);
    document.body.removeChild(div);
  });

  it("prefers data-vibeflow-id for selector and display", () => {
    const div = document.createElement("div");
    div.setAttribute("data-vibeflow-id", "hero-title");
    document.body.appendChild(div);
    const p = buildSourcePointer(div);
    expect(p.selector).toBe('[data-vibeflow-id="hero-title"]');
    expect(p.display).toBe("hero-title");
    document.body.removeChild(div);
  });

  it("surfaces test_id from element's own data-testid", () => {
    const div = document.createElement("div");
    div.setAttribute("data-testid", "submit-btn");
    document.body.appendChild(div);
    const p = buildSourcePointer(div);
    expect(p.test_id).toBe("submit-btn");
    document.body.removeChild(div);
  });

  it("uses data-testid selector as primary selector when no framework source", () => {
    const div = document.createElement("div");
    div.setAttribute("data-testid", "checkout-submit");
    document.body.appendChild(div);
    const p = buildSourcePointer(div);
    expect(p.selector).toBe('[data-testid="checkout-submit"]');
    document.body.removeChild(div);
  });

  it("surfaces test_id from ancestor data-testid", () => {
    const parent = document.createElement("div");
    parent.setAttribute("data-testid", "form-section");
    const child = document.createElement("input");
    parent.appendChild(child);
    document.body.appendChild(parent);
    const p = buildSourcePointer(child);
    expect(p.test_id).toBe("form-section");
    document.body.removeChild(parent);
  });

  it("surfaces test_id from data-cy", () => {
    const btn = document.createElement("button");
    btn.setAttribute("data-cy", "accept-terms");
    document.body.appendChild(btn);
    expect(buildSourcePointer(btn).test_id).toBe("accept-terms");
    document.body.removeChild(btn);
  });

  it("does not add test_id from UUID-like id", () => {
    const div = document.createElement("div");
    div.id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";  // valid UUID (all hex + dashes)
    document.body.appendChild(div);
    expect(buildSourcePointer(div).test_id).toBeUndefined();
    document.body.removeChild(div);
  });

  it("uses semantic id selector as primary selector", () => {
    const div = document.createElement("div");
    div.id = "primary-cta";
    document.body.appendChild(div);
    const p = buildSourcePointer(div);
    expect(p.selector).toBe("#primary-cta");
    document.body.removeChild(div);
  });

  it("returns no file/line/component for plain DOM elements (no framework)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const p = buildSourcePointer(div);
    expect(p.file).toBeUndefined();
    expect(p.line).toBeUndefined();
    expect(p.col).toBeUndefined();
    expect(p.component).toBeUndefined();
    document.body.removeChild(div);
  });

  it("uses display from test_id when no proto-id present", () => {
    const div = document.createElement("div");
    div.setAttribute("data-testid", "profile-card");
    document.body.appendChild(div);
    const p = buildSourcePointer(div);
    expect(p.display).toContain("profile-card");
    document.body.removeChild(div);
  });

  // ── Next.js / React additional edge cases ──────────────────────────────────

  it("handles Next.js App Router: displayName via fiber.type.displayName", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$nextjs";
    (div as any)[fiberKey] = {
      _debugSource: { fileName: "/app/page.tsx", lineNumber: 15, columnNumber: 2 },
      _debugOwner: { type: { displayName: "PageComponent" } },
      return: null,
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBe("/app/page.tsx");
    expect(p.component).toBe("PageComponent");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("handles React fiber with deep return chain to find _debugSource", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$deep";
    (div as any)[fiberKey] = {
      _debugSource: null,
      _debugOwner: null,
      return: {
        _debugSource: null,
        _debugOwner: null,
        return: {
          _debugSource: { fileName: "/src/Deep.tsx", lineNumber: 99, columnNumber: 1 },
          _debugOwner: { type: { name: "DeepComponent" } },
        },
      },
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBe("/src/Deep.tsx");
    expect(p.component).toBe("DeepComponent");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("handles Vue 3 component with neither name nor __name (falls back to file only)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    (div as any).__vueParentComponent = {
      type: { __file: "/src/Anonymous.vue" },
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBe("/src/Anonymous.vue");
    document.body.removeChild(div);
  });

  it("handles Angular component via constructor.displayName", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const mockComponent = { constructor: { displayName: "FooterComponent", name: "FooterComponent" } };
    (window as any).ng = {
      getComponent: (el: Element) => el === div ? mockComponent : null,
    };
    const p = buildSourcePointer(div);
    expect(p.component).toBe("FooterComponent");
    delete (window as any).ng;
    document.body.removeChild(div);
  });

  it("returns no component when ng.getComponent() returns null", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    (window as any).ng = { getComponent: () => null };
    const p = buildSourcePointer(div);
    expect(p.component).toBeUndefined();
    delete (window as any).ng;
    document.body.removeChild(div);
  });

  it("uses source file as selector when React _debugSource is available", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$selectorPriority";
    (div as any)[fiberKey] = {
      _debugSource: { fileName: "/src/App.tsx", lineNumber: 42, columnNumber: 7 },
      _debugOwner: { type: { displayName: "App" } },
    };
    const p = buildSourcePointer(div);
    expect(p.selector).toBe("/src/App.tsx:42");
    expect(p.display).toContain("App.tsx:42");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("uses component name as selector when only component is available (React 18+)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$componentSelector";
    (div as any)[fiberKey] = {
      _debugOwner: { type: { name: "Dashboard" } },
      return: null,
    };
    const p = buildSourcePointer(div);
    expect(p.selector).toBe("Dashboard");
    expect(p.display).toBe("Dashboard");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("source file selector takes priority over test-id", () => {
    const div = document.createElement("div");
    div.setAttribute("data-testid", "my-btn");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$filePriority";
    (div as any)[fiberKey] = {
      _debugSource: { fileName: "/src/Button.tsx", lineNumber: 5, columnNumber: 0 },
      _debugOwner: { type: { displayName: "Button" } },
    };
    const p = buildSourcePointer(div);
    expect(p.selector).toBe("/src/Button.tsx:5");
    expect(p.test_id).toBe("my-btn");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("component selector takes priority over test-id", () => {
    const div = document.createElement("div");
    div.setAttribute("data-testid", "nav-bar");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$componentPriority";
    (div as any)[fiberKey] = {
      _debugOwner: { type: { name: "NavBar" } },
      return: null,
    };
    const p = buildSourcePointer(div);
    expect(p.selector).toBe("NavBar");
    expect(p.test_id).toBe("nav-bar");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("extracts React _debugSource when present on fiber (Tier 1)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    // Simulate React dev fiber
    const fiberKey = "__reactFiber$test";
    (div as any)[fiberKey] = {
      _debugSource: { fileName: "/src/App.tsx", lineNumber: 42, columnNumber: 7 },
      _debugOwner: { type: { displayName: "App" } },
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBe("/src/App.tsx");
    expect(p.line).toBe(42);
    expect(p.col).toBe(7);
    expect(p.component).toBe("App");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("extracts React component name from _debugOwner.type.name (fallback)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$test2";
    (div as any)[fiberKey] = {
      _debugSource: { fileName: "/src/Button.tsx", lineNumber: 10, columnNumber: 0 },
      _debugOwner: { type: { name: "ButtonComponent" } }, // .name fallback
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBe("/src/Button.tsx");
    expect(p.component).toBe("ButtonComponent");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("traverses React fiber.return to find _debugSource on ancestor fiber", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$test3";
    // Fiber on element has no _debugSource itself, but parent fiber does
    (div as any)[fiberKey] = {
      _debugSource: null,
      return: {
        _debugSource: { fileName: "/src/Parent.tsx", lineNumber: 20, columnNumber: 5 },
        _debugOwner: { type: { displayName: "Parent" } },
      },
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBe("/src/Parent.tsx");
    expect(p.line).toBe(20);
    expect(p.component).toBe("Parent");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("uses __reactInternalInstance key as fallback for older React versions", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fiberKey = "__reactInternalInstance$old";
    (div as any)[fiberKey] = {
      _debugSource: { fileName: "/src/OldApp.tsx", lineNumber: 5, columnNumber: 1 },
      _debugOwner: null,
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBe("/src/OldApp.tsx");
    expect(p.line).toBe(5);
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("extracts component name from _debugOwner.type.name when _debugSource is absent (React 18+)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$react18";
    (div as any)[fiberKey] = {
      // No _debugSource — React 18+/19 behaviour
      _debugOwner: { type: { name: "MyWidget" } },
      return: null,
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBeUndefined();
    expect(p.component).toBe("MyWidget");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("extracts component name from _debugStack when _debugOwner is absent (React 19)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$react19";
    const fakeStack = new Error("react-stack-top-frame");
    fakeStack.stack = [
      "Error: react-stack-top-frame",
      "    at jsxDEV (http://localhost:3000/_next/static/chunks/react.js:211:33)",
      "    at SomeWidget (http://localhost:3000/_next/static/chunks/app.js:42:5)",
      "    at renderWithHooks (http://localhost:3000/_next/static/chunks/react-dom.js:999:10)",
    ].join("\n");
    (div as any)[fiberKey] = {
      // No _debugSource, no _debugOwner — React 19 with _debugStack only
      _debugOwner: null,
      _debugStack: fakeStack,
      return: null,
    };
    const p = buildSourcePointer(div);
    expect(p.component).toBe("SomeWidget");
    expect(p.file).toBeUndefined();
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("extracts Vue 3 file and component name from __vueParentComponent (Tier 1)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    (div as any).__vueParentComponent = {
      type: { __file: "/src/components/Card.vue", name: "Card" },
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBe("/src/components/Card.vue");
    expect(p.component).toBe("Card");
    delete (div as any).__vueParentComponent;
    document.body.removeChild(div);
  });

  it("extracts Vue 3 component name from type.__name when name is absent", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    (div as any).__vueParentComponent = {
      type: { __file: "/src/Hero.vue", __name: "Hero" },
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBe("/src/Hero.vue");
    expect(p.component).toBe("Hero");
    delete (div as any).__vueParentComponent;
    document.body.removeChild(div);
  });

  it("walks up DOM tree to find Vue 3 __vueParentComponent on ancestor", () => {
    const parent = document.createElement("section");
    const child = document.createElement("button");
    parent.appendChild(child);
    document.body.appendChild(parent);
    (parent as any).__vueParentComponent = {
      type: { __file: "/src/Section.vue", name: "Section" },
    };
    const p = buildSourcePointer(child);
    expect(p.file).toBe("/src/Section.vue");
    expect(p.component).toBe("Section");
    delete (parent as any).__vueParentComponent;
    document.body.removeChild(parent);
  });

  it("extracts Vue 2 file and component name from __vue__ (Tier 1)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    (div as any).__vue__ = {
      $options: { __file: "/src/legacy/Old.vue", name: "OldComp" },
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBe("/src/legacy/Old.vue");
    expect(p.component).toBe("OldComp");
    delete (div as any).__vue__;
    document.body.removeChild(div);
  });

  it("walks up DOM tree to find Vue 2 __vue__ on ancestor", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    document.body.appendChild(parent);
    (parent as any).__vue__ = {
      $options: { __file: "/src/MyVue2.vue", name: "MyVue2" },
    };
    const p = buildSourcePointer(child);
    expect(p.component).toBe("MyVue2");
    delete (parent as any).__vue__;
    document.body.removeChild(parent);
  });

  it("extracts Angular component name via ng.getComponent() global (Tier 1)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    // Simulate Angular ng global
    const mockComponent = { constructor: { name: "HeroComponent" } };
    (window as any).ng = {
      getComponent: (el: Element) => el === div ? mockComponent : null,
    };
    const p = buildSourcePointer(div);
    expect(p.component).toBe("HeroComponent");
    delete (window as any).ng;
    document.body.removeChild(div);
  });

  it("extracts Preact component from __P.__k[0] (Tier 1)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    (div as any).__P = {
      __k: [{ type: { name: "PreactButton" } }],
    };
    const p = buildSourcePointer(div);
    expect(p.component).toBe("PreactButton");
    delete (div as any).__P;
    document.body.removeChild(div);
  });

  it("skips null/primitive-type entries in Preact __P.__k to find named component", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    (div as any).__P = {
      __k: [
        null,
        { type: "div" }, // string type, skipped
        { type: { name: "RealWidget" } },
      ],
    };
    const p = buildSourcePointer(div);
    expect(p.component).toBe("RealWidget");
    delete (div as any).__P;
    document.body.removeChild(div);
  });

  it("combines Tier 1 React source with Tier 3a test_id (both are populated)", () => {
    const div = document.createElement("div");
    div.setAttribute("data-testid", "card-component");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$combined";
    (div as any)[fiberKey] = {
      _debugSource: { fileName: "/src/Card.tsx", lineNumber: 8, columnNumber: 0 },
      _debugOwner: { type: { displayName: "Card" } },
    };
    const p = buildSourcePointer(div);
    expect(p.file).toBe("/src/Card.tsx");
    expect(p.test_id).toBe("card-component");
    expect(p.component).toBe("Card");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("prefers source display and selector when framework metadata exists", () => {
    const div = document.createElement("div");
    div.setAttribute("data-testid", "card-component");
    document.body.appendChild(div);
    const fiberKey = "__reactFiber$displayPriority";
    (div as any)[fiberKey] = {
      _debugSource: { fileName: "/src/Card.tsx", lineNumber: 12, columnNumber: 4 },
      _debugOwner: { type: { displayName: "Card" } },
    };
    const p = buildSourcePointer(div);
    expect(p.display).toContain("Card.tsx");
    expect(p.display).toContain("12");
    expect(p.selector).toBe("/src/Card.tsx:12");
    expect(p.test_id).toBe("card-component");
    delete (div as any)[fiberKey];
    document.body.removeChild(div);
  });

  it("falls back to CSS selector when no framework detected", () => {
    const div = document.createElement("div");
    div.className = "my-widget";
    document.body.appendChild(div);
    const p = buildSourcePointer(div);
    expect(p.selector).toContain("my-widget");
    expect(p.file).toBeUndefined();
    expect(p.component).toBeUndefined();
    document.body.removeChild(div);
  });
});

describe("formatSourcePointerForAgent", () => {
  it("always includes Selector line", () => {
    const out = formatSourcePointerForAgent({ selector: "div.foo", display: "foo" });
    expect(out).toContain("Selector: div.foo");
  });

  it("includes full Source line with file, line, col, and component name", () => {
    const out = formatSourcePointerForAgent({
      selector: "form > button",
      display: "btn",
      file: "src/Button.tsx",
      line: 42,
      col: 3,
      component: "Button",
    });
    expect(out).toContain("Source: src/Button.tsx line 42 col 3 (Button)");
  });

  it("omits col from Source line when col is absent", () => {
    const out = formatSourcePointerForAgent({
      selector: "div",
      display: "d",
      file: "src/App.tsx",
      line: 10,
    });
    expect(out).toContain("Source: src/App.tsx line 10");
    expect(out).not.toContain("col");
  });

  it("includes TestID line when test_id is present", () => {
    const out = formatSourcePointerForAgent({ selector: "button", display: "btn", test_id: "submit-btn" });
    expect(out).toContain("TestID: submit-btn");
  });

  it("omits TestID line when test_id is absent", () => {
    const out = formatSourcePointerForAgent({ selector: "div", display: "d" });
    expect(out).not.toContain("TestID:");
  });

  it("omits Source line when file is absent", () => {
    const out = formatSourcePointerForAgent({ selector: "div", display: "d" });
    expect(out).not.toContain("Source:");
  });

  it("shows Component line when component present but file absent", () => {
    const out = formatSourcePointerForAgent({ selector: "button", display: "btn", component: "MyButton" });
    expect(out).toContain("Component: MyButton");
  });

  it("omits component from Component line when also in Source line", () => {
    const out = formatSourcePointerForAgent({
      selector: "div", display: "d", file: "src/C.tsx", component: "C",
    });
    expect(out).toContain("Source: src/C.tsx (C)");
    expect(out).not.toContain("Component:");
  });
});

// ── Tier 2b: isDirectSourceUrl ────────────────────────────────────────────────

describe("isDirectSourceUrl", () => {
  it("accepts Vite dev URL (.tsx with ?v= query)", () => {
    expect(isDirectSourceUrl("http://localhost:5173/src/components/Button.tsx?v=abc123")).toBe(true);
  });

  it("accepts plain .tsx absolute path (tsx/ts-node)", () => {
    expect(isDirectSourceUrl("/home/user/project/src/Button.tsx")).toBe(true);
  });

  it("accepts file:// URL (Deno)", () => {
    expect(isDirectSourceUrl("file:///home/user/project/src/main.ts")).toBe(true);
  });

  it("accepts .js source file", () => {
    expect(isDirectSourceUrl("http://localhost:3000/src/utils.js")).toBe(true);
  });

  it("accepts .mts extension", () => {
    expect(isDirectSourceUrl("/src/worker.mts")).toBe(true);
  });

  it("accepts .mjs extension", () => {
    expect(isDirectSourceUrl("/src/worker.mjs")).toBe(true);
  });

  it("accepts .jsx extension", () => {
    expect(isDirectSourceUrl("http://localhost:3000/src/App.jsx")).toBe(true);
  });

  it("accepts Vite URL without query", () => {
    expect(isDirectSourceUrl("http://localhost:5173/src/NavBar.tsx")).toBe(true);
  });

  it("rejects _next/static/chunks bundle", () => {
    expect(isDirectSourceUrl("http://localhost:3000/_next/static/chunks/page-abc1234567.js")).toBe(false);
  });

  it("rejects _next/dist path", () => {
    expect(isDirectSourceUrl("http://localhost:3000/_next/dist/react.js")).toBe(false);
  });

  it("rejects chunk-hash bundle URL", () => {
    expect(isDirectSourceUrl("http://localhost:3000/build/chunk-abc12345.js")).toBe(false);
  });

  it("rejects webpack bundle", () => {
    expect(isDirectSourceUrl("http://localhost:3000/webpack-internal:///./src/App.tsx")).toBe(false);
  });

  it("rejects node_modules path", () => {
    expect(isDirectSourceUrl("http://localhost:3000/node_modules/react/index.js")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isDirectSourceUrl("")).toBe(false);
  });

  it("rejects URL with no source extension", () => {
    expect(isDirectSourceUrl("http://localhost:3000/api/data")).toBe(false);
  });

  it("rejects React internal stack frame URL", () => {
    expect(isDirectSourceUrl("http://localhost:3000/node_modules/react/cjs/react-jsx-dev-runtime.development.js")).toBe(false);
  });
});

// ── Tier 2b: captureV8CallSites ───────────────────────────────────────────────

describe("captureV8CallSites", () => {
  it("returns null when Error.captureStackTrace is unavailable (non-V8 simulation)", () => {
    const origCapture = (Error as any).captureStackTrace;
    delete (Error as any).captureStackTrace;
    try {
      const err = new Error("test");
      expect(captureV8CallSites(err)).toBeNull();
    } finally {
      (Error as any).captureStackTrace = origCapture;
    }
  });

  it("does not throw in any environment", () => {
    const err = new Error("safe-test");
    expect(() => captureV8CallSites(err)).not.toThrow();
  });

  it("returns null or CallSite[] (never throws or returns other type)", () => {
    const err = new Error("type-test");
    const result = captureV8CallSites(err);
    expect(result === null || Array.isArray(result)).toBe(true);
  });

  it("restores Error.prepareStackTrace after call even if hook throws", () => {
    const original = (Error as any).prepareStackTrace;
    const err = new Error("restore-test");
    captureV8CallSites(err);
    expect((Error as any).prepareStackTrace).toBe(original);
  });

  it("returns CallSite[] with getFileName/getLineNumber methods in V8 (jsdom)", () => {
    const err = new Error("v8-test");
    const sites = captureV8CallSites(err);
    if (sites === null) return; // non-V8 env or already stringified
    expect(Array.isArray(sites)).toBe(true);
    expect(sites.length).toBeGreaterThan(0);
    expect(typeof sites[0].getFileName).toBe("function");
    expect(typeof sites[0].getLineNumber).toBe("function");
    expect(typeof sites[0].getColumnNumber).toBe("function");
  });
});

// ── Tier 2b: resolveDirectSourceFromStack ─────────────────────────────────────

describe("resolveDirectSourceFromStack", () => {
  it("returns null when element has no React fiber", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(resolveDirectSourceFromStack(div)).toBeNull();
    document.body.removeChild(div);
  });

  it("returns null when fiber has no _debugStack property", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    (div as any).__reactFiber$nostack = { _debugOwner: null, return: null };
    expect(resolveDirectSourceFromStack(div)).toBeNull();
    delete (div as any).__reactFiber$nostack;
    document.body.removeChild(div);
  });

  it("returns null when _debugStack is not an Error instance (plain object)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    (div as any).__reactFiber$notErr = { _debugStack: { stack: "not-an-error" }, return: null };
    expect(resolveDirectSourceFromStack(div)).toBeNull();
    delete (div as any).__reactFiber$notErr;
    document.body.removeChild(div);
  });

  it("extracts file/line/col from Vite-style URL in _debugStack.stack string", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fakeErr = new Error("react-stack-top-frame");
    fakeErr.stack = [
      "Error: react-stack-top-frame",
      "    at jsxDEV (http://localhost:5173/node_modules/react/cjs/react-jsx-dev-runtime.development.js:100:10)",
      "    at Button (http://localhost:5173/src/components/Button.tsx?v=abc123:42:7)",
      "    at renderWithHooks (http://localhost:5173/node_modules/react-dom/cjs/react-dom.development.js:999:10)",
    ].join("\n");
    (div as any).__reactFiber$tier2b = { _debugStack: fakeErr, return: null };
    const result = resolveDirectSourceFromStack(div);
    expect(result).not.toBeNull();
    expect(result?.file).toContain("Button.tsx");
    expect(result?.file).not.toContain("?v=abc123");
    expect(result?.line).toBe(42);
    expect(result?.col).toBe(7);
    delete (div as any).__reactFiber$tier2b;
    document.body.removeChild(div);
  });

  it("strips Vite host from URL (produces relative path)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fakeErr = new Error("react-stack-top-frame");
    fakeErr.stack = "    at NavBar (http://localhost:5173/src/layout/NavBar.tsx?v=xyz789:88:12)";
    (div as any).__reactFiber$strip = { _debugStack: fakeErr, return: null };
    const result = resolveDirectSourceFromStack(div);
    expect(result?.file).toBe("/src/layout/NavBar.tsx");
    expect(result?.line).toBe(88);
    delete (div as any).__reactFiber$strip;
    document.body.removeChild(div);
  });

  it("handles file:// Deno-style URL", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fakeErr = new Error("stack");
    fakeErr.stack = "    at MyComp (file:///home/user/project/src/MyComp.tsx:10:5)";
    (div as any).__reactFiber$deno = { _debugStack: fakeErr, return: null };
    const result = resolveDirectSourceFromStack(div);
    expect(result?.file).toContain("MyComp.tsx");
    expect(result?.line).toBe(10);
    delete (div as any).__reactFiber$deno;
    document.body.removeChild(div);
  });

  it("returns null when all _debugStack frames are bundled chunks", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fakeErr = new Error("react-stack-top-frame");
    fakeErr.stack = [
      "Error: react-stack-top-frame",
      "    at Button (http://localhost:3000/_next/static/chunks/app-hash1234567.js:42:7)",
    ].join("\n");
    (div as any).__reactFiber$bundle = { _debugStack: fakeErr, return: null };
    expect(resolveDirectSourceFromStack(div)).toBeNull();
    delete (div as any).__reactFiber$bundle;
    document.body.removeChild(div);
  });

  it("returns null when all frames are React internals (node_modules)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fakeErr = new Error("react-stack-top-frame");
    fakeErr.stack = [
      "    at jsxDEV (http://localhost:5173/node_modules/react/cjs/react.dev.js:10:5)",
    ].join("\n");
    (div as any).__reactFiber$intern = { _debugStack: fakeErr, return: null };
    expect(resolveDirectSourceFromStack(div)).toBeNull();
    delete (div as any).__reactFiber$intern;
    document.body.removeChild(div);
  });

  it("skips non-matching lines and returns first valid direct source frame", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fakeErr = new Error("react-stack-top-frame");
    fakeErr.stack = [
      "Error: react-stack-top-frame",
      "    at jsxDEV (http://localhost:5173/node_modules/react/cjs/react.dev.js:1:1)",
      "    at ignore this line without valid format",
      "    at ProfileCard (http://localhost:5173/src/components/ProfileCard.tsx?v=zzz:55:3)",
      "    at App (http://localhost:5173/src/App.tsx?v=aaa:12:1)",
    ].join("\n");
    (div as any).__reactFiber$first = { _debugStack: fakeErr, return: null };
    const result = resolveDirectSourceFromStack(div);
    expect(result?.file).toContain("ProfileCard.tsx");
    expect(result?.line).toBe(55);
    delete (div as any).__reactFiber$first;
    document.body.removeChild(div);
  });
});

// ── buildSourcePointerAsync — Tier 2b integration ─────────────────────────────

describe("buildSourcePointerAsync — Tier 2b direct source extraction", () => {
  it("fills file/line from Vite-style _debugStack without source map fetch", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fakeErr = new Error("react-stack-top-frame");
    fakeErr.stack = [
      "Error: react-stack-top-frame",
      "    at jsxDEV (http://localhost:5173/node_modules/react/cjs/react.dev.js:1:1)",
      "    at ProfileCard (http://localhost:5173/src/components/ProfileCard.tsx?v=zyx987:55:3)",
    ].join("\n");
    (div as any).__reactFiber$async2b = { _debugStack: fakeErr, return: null };
    const pointer = await buildSourcePointerAsync(div);
    expect(pointer.file).toContain("ProfileCard.tsx");
    expect(pointer.line).toBe(55);
    expect(pointer.selector).toContain("ProfileCard.tsx:55");
    delete (div as any).__reactFiber$async2b;
    document.body.removeChild(div);
  });

  it("Tier 1 (_debugSource) takes priority over Tier 2b", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fakeErr = new Error("react-stack-top-frame");
    fakeErr.stack = "    at Foo (http://localhost:5173/src/Foo.tsx:99:1)";
    (div as any).__reactFiber$t1wins = {
      _debugSource: { fileName: "/src/Actual.tsx", lineNumber: 10, columnNumber: 0 },
      _debugStack: fakeErr,
      return: null,
    };
    const pointer = await buildSourcePointerAsync(div);
    expect(pointer.file).toBe("/src/Actual.tsx");
    expect(pointer.line).toBe(10);
    delete (div as any).__reactFiber$t1wins;
    document.body.removeChild(div);
  });

  it("falls through to CSS selector when both Tier 2b and Tier 2 find nothing", async () => {
    // All frames are node_modules — matched by SKIP_FRAME_RE in both Tier 2b
    // (isDirectSourceUrl) and Tier 2 (parseUserFrame), so no network fetch is
    // attempted and the result immediately falls back to the CSS selector.
    const div = document.createElement("div");
    div.id = "fallthrough-test";
    document.body.appendChild(div);
    const fakeErr = new Error("react-stack-top-frame");
    fakeErr.stack = [
      "    at renderWithHooks (http://localhost:3000/node_modules/react-dom/cjs/react-dom.development.js:100:5)",
    ].join("\n");
    (div as any).__reactFiber$fall = { _debugStack: fakeErr, return: null };
    const pointer = await buildSourcePointerAsync(div);
    expect(pointer.file).toBeUndefined();
    expect(pointer.selector).toBe("#fallthrough-test");
    delete (div as any).__reactFiber$fall;
    document.body.removeChild(div);
  });

  it("sets display to filename:line format from Tier 2b result", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const fakeErr = new Error("react-stack-top-frame");
    fakeErr.stack = "    at Hero (http://localhost:5173/src/Hero.tsx?v=aaa:7:1)";
    (div as any).__reactFiber$disp = { _debugStack: fakeErr, return: null };
    const pointer = await buildSourcePointerAsync(div);
    expect(pointer.display).toBe("Hero.tsx:7");
    delete (div as any).__reactFiber$disp;
    document.body.removeChild(div);
  });
});
