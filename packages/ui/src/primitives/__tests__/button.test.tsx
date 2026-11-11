// @vitest-environment jsdom
/**
 * Button unit tests — every variant × size renders its token classes, and
 * behaviour (not just render) is asserted: click fires once, disabled and
 * loading block the handler, keyboard Enter/Space activate, the
 * focus-visible ring differs from the resting style.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { Button } from "../button";

afterEach(cleanup);

/**
 * The remaining branch in `onClick` is the optional-handler path: a Button with
 * no onClick must still be clickable and must not throw (browsers dispatch the
 * click; our wrapper simply has nothing to call). Covered so the primitive's
 * branch coverage reflects the real contract rather than a happy-path subset.
 */
describe("Button without a handler", () => {
  it("is clickable and does not throw when no onClick is supplied", async () => {
    render(<Button>No handler</Button>);
    const button = screen.getByRole("button");
    await userEvent.click(button);
    expect(button).toBeEnabled();
  });

  it("stays a no-op while loading even without a handler", async () => {
    render(<Button loading>Saving</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(button).toBeDisabled();
  });
});

const VARIANTS = [
  { variant: "primary", token: "bg-accent" },
  { variant: "secondary", token: "bg-bg-raised" },
  { variant: "ghost", token: "bg-transparent" },
  { variant: "danger", token: "bg-danger-soft" },
] as const;

const SIZES = [
  { size: "sm", token: "text-xs" },
  { size: "md", token: "text-sm" },
  { size: "lg", token: "text-base" },
] as const;

describe("Button", () => {
  it("renders primary/medium by default with type=button", () => {
    render(<Button>Save</Button>);
    const action = screen.getByRole("button");
    expect(action).toHaveTextContent("Save");
    expect(action).toHaveAttribute("type", "button");
    expect(action.className).toContain("bg-accent");
    expect(action.className).toContain("text-sm");
  });

  for (const { variant, token } of VARIANTS) {
    it(`resolves the ${variant} variant token classes`, () => {
      render(<Button variant={variant}>Label</Button>);
      expect(screen.getByRole("button").className).toContain(token);
    });
  }

  for (const { size, token } of SIZES) {
    it(`resolves the ${size} size token classes`, () => {
      render(<Button size={size}>Label</Button>);
      expect(screen.getByRole("button").className).toContain(token);
    });
  }

  it("fires onClick exactly once per click with the event", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Save</Button>);
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick when disabled", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    const action = screen.getByRole("button");
    expect(action).toBeDisabled();
    await user.click(action);
    fireEvent.click(action);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("sets aria-busy, shows a spinner, and blocks onClick when loading", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const action = screen.getByRole("button");
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(action).toBeDisabled();
    expect(screen.getByTestId("Button-spinner")).toBeVisible();
    await user.click(action);
    fireEvent.click(action);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("has no aria-busy and no spinner when idle", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button")).not.toHaveAttribute(
      "aria-busy",
    );
    expect(screen.queryByTestId("Button-spinner")).not.toBeInTheDocument();
  });

  it("activates with keyboard Enter", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Save</Button>);
    screen.getByRole("button").focus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("activates with keyboard Space", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Save</Button>);
    screen.getByRole("button").focus();
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keyboard activation is blocked while loading", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    screen.getByRole("button").focus();
    await user.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("carries a focus-visible ring that differs from the resting style", () => {
    render(<Button>Save</Button>);
    const action = screen.getByRole("button");
    action.focus();
    expect(document.activeElement).toBe(action);
    // Resting style has no outline utility; keyboard focus adds the
    // token-driven ring — the two states resolve differently.
    expect(action.className).toContain("focus-visible:outline-accent");
    expect(action.className).not.toMatch(/(^|\s)outline-accent(\s|$)/);
  });

  it("honours an explicit submit type", () => {
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole("button")).toHaveAttribute(
      "type",
      "submit",
    );
  });

  it("merges an extra className last", () => {
    render(<Button className="extra-class">Hi</Button>);
    expect(screen.getByRole("button").className).toContain(
      "extra-class",
    );
  });
});
