import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { useEffect } from "react";
import { VariantProvider, useVariantContext } from "../src/context.js";
import { VariantDevToolbar } from "../src/VariantDevToolbar.js";

/** Helper: registers a scope so the toolbar shows it. */
function ScopeRegistrar({ name, keys }: { name: string; keys: string[] }) {
  const ctx = useVariantContext();
  useEffect(() => {
    ctx.registerScope(name, keys);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function TestApp({
  defaultVisible = true,
  scopes = [{ name: "Layout", keys: ["columns", "swimlane"] }],
  children,
}: {
  defaultVisible?: boolean;
  scopes?: Array<{ name: string; keys: string[] }>;
  children?: React.ReactNode;
}) {
  return (
    <VariantProvider defaultVisible={defaultVisible}>
      {scopes.map((s) => (
        <ScopeRegistrar key={s.name} name={s.name} keys={s.keys} />
      ))}
      <VariantDevToolbar />
      {children}
    </VariantProvider>
  );
}

describe("VariantDevToolbar", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    // Clean up any vibeflow overlay root injected during tests
    document.getElementById("vibeflow-studio-root")?.remove();
    // Clean up __vf_prototyping API
    delete (window as any).__vf_prototyping;
  });

  it("renders the toggle button when uiVisible is true", () => {
    render(<TestApp />);
    expect(
      screen.getByRole("button", { name: /Toggle variant dev toolbar/ }),
    ).toBeInTheDocument();
  });

  it("toggle button is absent when uiVisible is false", () => {
    render(<TestApp defaultVisible={false} />);
    expect(
      screen.queryByRole("button", { name: /Toggle variant dev toolbar/ }),
    ).toBeNull();
  });

  it("opens the panel when toggle button is clicked", async () => {
    const user = userEvent.setup();
    render(<TestApp />);
    await user.click(
      screen.getByRole("button", { name: /Toggle variant dev toolbar/ }),
    );
    expect(screen.getByRole("dialog", { name: /Variant dev toolbar/ })).toBeInTheDocument();
  });

  it("closes the panel when × is clicked", async () => {
    const user = userEvent.setup();
    render(<TestApp />);
    await user.click(
      screen.getByRole("button", { name: /Toggle variant dev toolbar/ }),
    );
    await user.click(screen.getByRole("button", { name: /Close toolbar/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows registered scopes inside the panel", async () => {
    const user = userEvent.setup();
    render(<TestApp scopes={[{ name: "Layout", keys: ["columns", "swimlane"] }]} />);
    await user.click(
      screen.getByRole("button", { name: /Toggle variant dev toolbar/ }),
    );
    expect(screen.getByText("Layout")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Switch Layout to columns/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Switch Layout to swimlane/ })).toBeInTheDocument();
  });

  it("shows empty state message when no scopes registered", async () => {
    const user = userEvent.setup();
    render(<TestApp scopes={[]} />);
    await user.click(
      screen.getByRole("button", { name: /Toggle variant dev toolbar/ }),
    );
    expect(screen.getByText(/No variant scopes registered/)).toBeInTheDocument();
  });

  it("switching variant via toolbar updates active state", async () => {
    const user = userEvent.setup();
    render(<TestApp scopes={[{ name: "Layout", keys: ["columns", "swimlane"] }]} />);
    await user.click(
      screen.getByRole("button", { name: /Toggle variant dev toolbar/ }),
    );
    const swimlaneBtn = screen.getByRole("radio", { name: /Switch Layout to swimlane/ });
    await user.click(swimlaneBtn);
    expect(swimlaneBtn).toHaveAttribute("aria-checked", "true");
  });

  it("UI toggle button inside toolbar toggles uiVisible", async () => {
    const user = userEvent.setup();
    render(<TestApp />);
    await user.click(
      screen.getByRole("button", { name: /Toggle variant dev toolbar/ }),
    );
    // Panel is open, click "Hide switchers"
    const hideBtn = screen.getByRole("button", { name: /Hide switchers/ });
    await user.click(hideBtn);
    // After hiding, toggle button itself disappears
    expect(
      screen.queryByRole("button", { name: /Toggle variant dev toolbar/ }),
    ).toBeNull();
  });

  it("pressing Escape closes the panel", async () => {
    const user = userEvent.setup();
    render(<TestApp />);
    await user.click(
      screen.getByRole("button", { name: /Toggle variant dev toolbar/ }),
    );
    expect(screen.getByRole("dialog", { name: /Variant dev toolbar/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clicking outside the panel closes it", async () => {
    const user = userEvent.setup();
    render(
      <TestApp>
        <span data-testid="outside">outside</span>
      </TestApp>,
    );
    await user.click(
      screen.getByRole("button", { name: /Toggle variant dev toolbar/ }),
    );
    expect(screen.getByRole("dialog", { name: /Variant dev toolbar/ })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  describe("Vibeflow overlay integration", () => {
    it("hides the toggle button when the Vibeflow overlay is present", () => {
      // Simulate Vibeflow overlay being present in the page
      const host = document.createElement("div");
      host.id = "vibeflow-studio-root";
      document.body.appendChild(host);

      render(<TestApp />);

      // The toggle button should be hidden when the overlay is detected
      expect(
        screen.queryByRole("button", { name: /Toggle variant dev toolbar/ }),
      ).toBeNull();
    });

    it("registers __vf_prototyping API on window when overlay is detected", async () => {
      const host = document.createElement("div");
      host.id = "vibeflow-studio-root";
      document.body.appendChild(host);

      render(<TestApp />);

      // Allow the useEffect to run
      await act(async () => {});

      expect((window as any).__vf_prototyping).toBeDefined();
      expect(typeof (window as any).__vf_prototyping.openPanel).toBe("function");
      expect(typeof (window as any).__vf_prototyping.closePanel).toBe("function");
    });

    it("openPanel via __vf_prototyping API opens the panel", async () => {
      const host = document.createElement("div");
      host.id = "vibeflow-studio-root";
      document.body.appendChild(host);

      render(<TestApp />);

      await act(async () => {});

      expect(screen.queryByRole("dialog")).toBeNull();

      act(() => {
        (window as any).__vf_prototyping.openPanel();
      });

      expect(screen.getByRole("dialog", { name: /Variant dev toolbar/ })).toBeInTheDocument();
    });

    it("closePanel via __vf_prototyping API closes the panel", async () => {
      const host = document.createElement("div");
      host.id = "vibeflow-studio-root";
      document.body.appendChild(host);

      render(<TestApp />);

      await act(async () => {});

      // Open via API
      act(() => { (window as any).__vf_prototyping.openPanel(); });
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      // Close via API
      act(() => { (window as any).__vf_prototyping.closePanel(); });
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
