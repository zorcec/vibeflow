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
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={style}
      className={className}
      aria-label="Vibeflow"
    >
      <rect width="32" height="32" rx="7" fill="#2563eb" />
      <rect x="7" y="13" width="3.5" height="10" rx="1.5" fill="white" opacity="0.75" />
      <rect x="12.25" y="8.5" width="3.5" height="15" rx="1.5" fill="white" />
      <rect x="17.5" y="14.5" width="3.5" height="8" rx="1.5" fill="white" opacity="0.75" />
      <rect x="22.5" y="11" width="2.5" height="11" rx="1.25" fill="white" opacity="0.85" />
    </svg>
  );
}
