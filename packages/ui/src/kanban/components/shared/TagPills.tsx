/**
 * TagPills — read-only display of tags on task cards.
 * Also used inside DetailPanel for the non-editing view.
 */
import React from 'react';
import { getTagColors } from '../../tag-colors';

interface Props {
  tags: string[];
  /** When provided, clicking × removes the tag. */
  onRemove?: (tag: string) => void;
  size?: 'sm' | 'xs';
}

export function TagPills({ tags, onRemove, size = 'sm' }: Props) {
  if (!tags.length) return null;
  const padding = size === 'xs' ? '1px 6px' : '2px 7px';
  const fontSize = size === 'xs' ? 9 : 10;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
      {tags.map(tag => {
        const { bg, text, border } = getTagColors(tag);
        return (
          <span
            key={tag}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding, borderRadius: 100,
              background: bg, border: `1px solid ${border}`, color: text,
              fontSize, fontWeight: 600, whiteSpace: 'nowrap',
            }}
          >
            {tag}
            {onRemove && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemove(tag); }}
                style={{ display: 'flex', background: 'none', border: 'none', color: text, cursor: 'pointer', padding: 0, lineHeight: 1, opacity: 0.7 }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
              >×</button>
            )}
          </span>
        );
      })}
    </div>
  );
}
