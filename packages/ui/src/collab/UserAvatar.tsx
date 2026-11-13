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
  return `hsl(${hue}, 65%, 55%)`;
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
        background: `${color}28`,
        border: `1px solid ${color}55`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize,
        fontWeight: 700,
        color,
        flexShrink: 0,
      }}
      title={user}
      aria-label={user}
    >
      {initials}
    </div>
  );
}
