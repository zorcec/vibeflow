import React from 'react';

interface HeaderActionButtonProps {
  id?: string;
  title: string;
  onClick: () => void;
  label?: string;
  icon?: React.ReactNode;
  variant?: 'neutral' | 'accent';
}

export function HeaderActionButton({
  id,
  title,
  onClick,
  label,
  icon,
  variant = 'neutral',
}: HeaderActionButtonProps) {
  const baseClass = 'h-7 inline-flex items-center justify-center rounded-lg transition-colors';
  const neutralClass = 'kb-action-btn';
  const accentClass = 'kb-action-btn kb-action-btn--accent';

  return (
    <button
      id={id}
      onClick={onClick}
      title={title}
      className={`${baseClass} ${variant === 'accent' ? accentClass : neutralClass} ${label ? 'gap-1.5 px-3 text-xs font-medium' : 'w-7'}`}
      type="button"
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}
