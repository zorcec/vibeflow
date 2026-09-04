import React from 'react';

interface VibeflowIconProps {
  size?: number;
  style?: React.CSSProperties;
  className?: string;
}

/**
 * Vibeflow brand icon — Equalizer Wave.
 * Four variable-height bars on a blue background, representing rhythm and flow.
 * Single source of truth: import from @vibeflow/ui everywhere.
 */
export function VibeflowIcon({ size = 32, style, className }: VibeflowIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={style}
      className={className}
      aria-label="Vibeflow"
      role="img"
    >
      <rect width="18" height="18" rx="4" fill="#2563eb" />
      <rect x="2.5" y="4" width="2.5" height="10" rx="1" fill="white" opacity="0.9" />
      <rect x="6.5" y="3" width="2.5" height="12" rx="1" fill="white" />
      <rect x="10.5" y="5" width="2.5" height="8" rx="1" fill="white" opacity="0.8" />
      <rect x="14.5" y="6" width="2.5" height="6" rx="1" fill="white" opacity="0.6" />
    </svg>
  );
}
