import React from 'react';
import { Button } from '../../../primitives';

interface HeaderActionButtonProps {
  id?: string;
  title: string;
  onClick: () => void;
  label?: string;
  icon?: React.ReactNode;
  variant?: 'neutral' | 'accent';
}

/**
 * Header action button (P13.2) — renders through the Button primitive.
 *
 * The `kb-action-btn` class stays on the element: it is the unlayered
 * kanban.css rule that supplies the control's border/background/text colours
 * (unlayered CSS outranks the @layer utilities tier), so the visuals are
 * byte-identical to the pre-primitive button while the primitive contributes
 * its type="button" default, focus ring and class merging.
 */
export function HeaderActionButton({
  id,
  title,
  onClick,
  label,
  icon,
  variant = 'neutral',
}: HeaderActionButtonProps) {
  return (
    <Button
      id={id}
      onClick={onClick}
      title={title}
      variant="ghost"
      size="sm"
      className={`h-7 rounded-lg ${variant === 'accent' ? 'kb-action-btn kb-action-btn--accent' : 'kb-action-btn'} ${label ? 'gap-1.5 px-3' : 'w-7'}`}
    >
      {icon}
      {label && <span>{label}</span>}
    </Button>
  );
}
