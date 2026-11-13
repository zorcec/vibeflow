import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { VerifiedEmailBadge } from "../VerifiedEmailBadge";
import { UserAvatar } from "../UserAvatar";
import { InactivityVeil } from "../InactivityVeil";
import { timeAgo } from "../timeAgo";

/**
 * P17d.1 — these three components moved into the public package because they
 * are data-free. The tests pin the properties that made them safe to move:
 * no fetch, no framework dependency, deterministic rendering.
 */
describe("VerifiedEmailBadge", () => {
  it("renders the verified marker for true", () => {
    render(<VerifiedEmailBadge verified={true} />);
    expect(screen.getByTestId("member-verified")).toBeTruthy();
  });

  it("renders the unverified marker for false", () => {
    render(<VerifiedEmailBadge verified={false} />);
    expect(screen.getByTestId("member-unverified")).toBeTruthy();
  });

  it("renders nothing for null/undefined — the MembersOverview contract", () => {
    const { container: a } = render(<VerifiedEmailBadge verified={null} />);
    const { container: b } = render(<VerifiedEmailBadge />);
    expect(a.innerHTML).toBe("");
    expect(b.innerHTML).toBe("");
  });
});

describe("UserAvatar", () => {
  it("falls back to initials with no image", () => {
    render(<UserAvatar user="Ada Lovelace" />);
    expect(screen.getByText("AL")).toBeTruthy();
  });

  it("uses the default plain <img> so the package needs no next/image", () => {
    const { container } = render(<UserAvatar user="Grace" imageUrl="/a.png" />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("alt")).toBe("Grace");
  });

  it("renders through an injected image component", () => {
    const Injected = (p: { src: string; alt: string }) => (
      <em data-testid="injected">{p.alt}</em>
    );
    render(
      <UserAvatar
        user="Grace"
        imageUrl="/a.png"
        imageComponent={Injected as never}
      />,
    );
    expect(screen.getByTestId("injected").textContent).toBe("Grace");
  });
});

describe("InactivityVeil", () => {
  it("is purely visual — never a hit target", () => {
    const { container } = render(<InactivityVeil />);
    const veil = container.firstElementChild as HTMLElement;
    expect(veil.getAttribute("aria-hidden")).toBe("true");
    expect(veil.style.pointerEvents).toBe("none");
  });
});

describe("timeAgo", () => {
  it("formats a relative stamp from a Date", () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 5 * 60_000))).toBe("5m ago");
    expect(timeAgo(new Date(now - 3 * 3_600_000))).toBe("3h ago");
  });
});
