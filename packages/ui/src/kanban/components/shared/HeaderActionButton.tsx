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
  const baseClass = 'h-7 inline-flex items-center justify-center rounded-lg border transition-colors';
  const neutralClass = 'border-slate-700/60 bg-slate-800 text-slate-400 hover:bg-slate-700/50 hover:text-slate-200';
  const accentClass = 'border-violet-700/50 bg-violet-900/30 text-violet-300 hover:bg-violet-800/30';

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
