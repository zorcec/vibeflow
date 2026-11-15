"use client";

import React from "react";

interface VerifiedEmailBadgeProps {
  /**
   * Tri-state verified-email flag (ticket h4vehyus). `true` renders the
   * green check, `false` the muted "unverified" marker, and an absent or
   * null flag renders nothing — exactly the MembersOverview contract, so
   * rows whose query did not select the flag stay unbadged.
   */
  verified?: boolean | null;
  /** Human label used in the aria-label, e.g. the member display name. */
  label?: string;
  /**
   * Test-id overrides. Defaults keep the live MembersOverview surface
   * (`member-verified` / `member-unverified`); the admin panel passes
   * row-scoped ids (`user-verified-<id>` …) per its data-testid
   * conventions without forking the badge.
   */
  verifiedTestId?: string;
  unverifiedTestId?: string;
}

/**
 * Shared verified-email badge (tickets h4vehyus, dqf9ovhro). Extracted
 * from MembersOverviewPanel — the green check / muted "unverified" pair
 * with identical styles, titles and tri-state behaviour. MembersOverview
 * and the admin Users & Boards tab both render this component.
 */
export function VerifiedEmailBadge({
  verified,
  label,
  verifiedTestId = "member-verified",
  unverifiedTestId = "member-unverified",
}: VerifiedEmailBadgeProps) {
  if (verified === true) {
    return (
      <span
        data-testid={verifiedTestId}
        title="Verified email"
        aria-label={label ? `${label}: verified email` : "Verified email"}
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: "var(--p-green)",
          flexShrink: 0,
        }}
      >
        ✓
      </span>
    );
  }
  if (verified === false) {
    return (
      <span
        data-testid={unverifiedTestId}
        title="Email not verified"
        aria-label={label ? `${label}: email not verified` : "Email not verified"}
        style={{
          fontSize: 9,
          fontWeight: 600,
          color: "var(--p-text-g)",
          flexShrink: 0,
        }}
      >
        unverified
      </span>
    );
  }
  return null;
}
