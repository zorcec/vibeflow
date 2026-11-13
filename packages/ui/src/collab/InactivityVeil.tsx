"use client";

// Explicit React import: consumers using the classic JSX transform
// (the hosted app's vitest) throw "React is not defined" without it.
import React from "react";

/**
 * Away veil (ticket xpm4z3n3 — "sometimes I have to click twice").
 *
 * After 5 idle minutes the session goes stale on purpose: realtime collab is
 * disabled while inactive and the board runs with no refetchInterval or
 * refetchOnWindowFocus, so the veil says "you've been away" and the app
 * refetches once on wake. That staleness protection stays.
 *
 * What changed is the veil must NEVER be a hit target: it is purely visual
 * (`pointerEvents: "none"`, no click handler), so the first click after
 * idle passes straight through to the menu/control underneath AND wakes the
 * session (the global activity handler in useInactivityDetection fires on
 * the down-stroke, before click dispatches). The old viewport-fixed button
 * overlay ate that first click — dismiss first, act second.
 */
export function InactivityVeil() {
  return (
    <div
      id="inactivity-overlay"
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(2, 12, 27, 0.85)",
        backdropFilter: "blur(10px)",
        // The whole fix: never intercept pointer hits. Clicks land on the
        // control below; do NOT re-add an onClick/onPointerDown here — a
        // blocking veil reintroduces the swallowed-first-click bug even if
        // it dismisses, because the covered control never receives the click.
        pointerEvents: "none",
        gap: 0,
      }}
    >
      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: "50%",
          background: "rgba(30, 64, 175, 0.15)",
          border: "1.5px solid rgba(37, 99, 235, 0.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 28,
          animation:
            "away-glow 3s ease-in-out infinite, away-fade-in 0.4s ease-out",
          backdropFilter: "blur(4px)",
        }}
      >
        <svg
          width={52}
          height={52}
          viewBox="0 0 18 18"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-label="Vibeflow"
        >
          <rect width="18" height="18" rx="4" fill="#1e40af" />
          <rect
            x="2.5"
            y="5"
            width="2"
            height="8"
            rx="1"
            fill="white"
            opacity="0.7"
          />
          <rect x="6.5" y="2" width="2" height="14" rx="1" fill="white" />
          <rect
            x="10.5"
            y="6"
            width="2"
            height="6"
            rx="1"
            fill="white"
            opacity="0.7"
          />
          <rect
            x="14.5"
            y="4"
            width="2"
            height="10"
            rx="1"
            fill="white"
            opacity="0.85"
          />
        </svg>
      </div>
      <p
        style={{
          color: "var(--p-text)",
          fontSize: 16,
          fontWeight: 600,
          margin: "0 0 6px",
          letterSpacing: "-0.01em",
        }}
      >
        You&apos;ve been away
      </p>
      <p style={{ color: "var(--p-text-m)", fontSize: 13, margin: 0 }}>
        Click anywhere to continue — the board refreshes underneath
      </p>
    </div>
  );
}
