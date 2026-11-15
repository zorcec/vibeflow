"use client";

import React from "react";

/**
 * P17d.1: this package is public and framework-agnostic, so it must not
 * depend on `next/image` (the CLI board and the overlay consume it too).
 * The photo renderer is therefore injected: the hosted app passes Next's
 * `Image` (keeping its optimisation), everything else falls back to a plain
 * `<img>` with the identical geometry.
 */
export type AvatarImageComponent = React.ComponentType<{
  src: string;
  alt: string;
  width: number;
  height: number;
  style?: React.CSSProperties;
  title?: string;
}>;

function PlainAvatarImage(props: {
  src: string;
  alt: string;
  width: number;
  height: number;
  style?: React.CSSProperties;
  title?: string;
}) {
  return <img {...props} />;
}

function getUserInitials(user: string): string {
  const parts = user.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return user.slice(0, 2).toUpperCase();
}

function getUserColor(user: string): string {
  let hash = 0;
  for (let i = 0; i < user.length; i++) hash = (hash * 31 + user.charCodeAt(i)) & 0xfffffff;
  const hue = hash % 360;
  // 28% is the lightest lightness that keeps WHITE initials at >=4.5:1 for every
  // hue at 65% saturation (solved over h=0..359: at 29% the worst hue is 4.54;
  // at 30% it falls under 4.5). The disc is opaque so its contrast cannot depend
  // on the theme — that dependence was the whole defect.
  return `hsl(${hue}, 65%, 28%)`;
}

interface UserAvatarProps {
  user: string;
  size?: number;
  fontSize?: number;
  imageUrl?: string | null;
  /** Photo renderer; see AvatarImageComponent. Defaults to a plain `<img>`. */
  imageComponent?: AvatarImageComponent;
}

export function UserAvatar({
  user,
  size = 22,
  fontSize = 9,
  imageUrl,
  imageComponent: ImageTag = PlainAvatarImage,
}: UserAvatarProps) {
  const initials = getUserInitials(user);
  const color = getUserColor(user);
  // Latent bug this replaces: `color` is `hsl(…)`, so `${color}28` produced
  // "hsl(…)28" — invalid CSS that browsers drop silently. The tint never
  // applied and the avatar rendered as coloured text directly on the page
  // surface, which is why the initials failed on every light theme (3.16-3.62:1).
  // An opaque fill plus white ink needs no theme knowledge at all.

  if (imageUrl) {
    return (
      <ImageTag
        src={imageUrl}
        alt={user}
        width={size}
        height={size}
        style={{ borderRadius: "50%", flexShrink: 0, objectFit: "cover" }}
        title={user}
      />
    );
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        border: `1px solid ${color}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize,
        fontWeight: 700,
        color: "#ffffff",
        flexShrink: 0,
      }}
      title={user}
      aria-label={user}
    >
      {initials}
    </div>
  );
}
