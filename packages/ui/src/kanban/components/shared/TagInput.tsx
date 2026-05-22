/**
 * TagInput — multi-value tag editor with autocomplete from global tag pool.
 * - Type to filter existing tags; press Enter or click to select.
 * - Unknown name + Enter → creates tag in pool and adds to task.
 * - Clicking × on a pill removes the tag from the task.
 */
import React from 'react';
import { TagPills } from './TagPills';
import { getTagColors } from '../../tag-colors';

interface Props {
  /** Current tags on the task. */
  tags: string[];
  /** Global pool of known tags (all unique tags across the project). */
  allTags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}

export function TagInput({ tags, allTags, onChange, disabled }: Props) {
  const [input, setInput] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const trimmed = input.trim().toLowerCase();

  const suggestions = React.useMemo(() => {
    const filtered = allTags.filter(t => !tags.includes(t) && t.toLowerCase().includes(trimmed));
    return filtered.slice(0, 8);
  }, [allTags, tags, trimmed]);

  const canCreate = trimmed.length > 0 && !allTags.some(t => t.toLowerCase() === trimmed) && !tags.some(t => t.toLowerCase() === trimmed);
  const canAddExisting = trimmed.length > 0 && allTags.some(t => t.toLowerCase() === trimmed) && !tags.some(t => t.toLowerCase() === trimmed);

  function addTag(name: string) {
    const tag = name.trim();
    if (!tag || tags.includes(tag)) return;
    onChange([...tags, tag]);
    setInput('');
    setOpen(false);
    inputRef.current?.focus();
  }

  function removeTag(tag: string) {
    onChange(tags.filter(t => t !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (canCreate || canAddExisting) {
        const exact = allTags.find(t => t.toLowerCase() === trimmed);
        addTag(exact ?? input.trim());
      } else if (suggestions.length > 0) {
        addTag(suggestions[0]);
      }
    }
    if (e.key === 'Escape') { setOpen(false); setInput(''); }
    if (e.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  }

  // Close dropdown on outside click
  React.useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const showDropdown = open && (suggestions.length > 0 || canCreate);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center',
          padding: '5px 8px', borderRadius: 8,
          border: `1px solid ${open ? 'var(--p-blue)' : 'var(--p-border)'}`,
          background: 'var(--p-input)',
          cursor: disabled ? 'not-allowed' : 'text',
          opacity: disabled ? 0.6 : 1,
          minHeight: 34, transition: 'border-color .12s',
        }}
        onClick={() => { if (!disabled) inputRef.current?.focus(); }}
      >
        <TagPills tags={tags} onRemove={disabled ? undefined : removeTag} size="sm" />
        {!disabled && (
          <input
            ref={inputRef}
            type="text"
            value={input}
            placeholder={tags.length ? '' : 'Add tags…'}
            onChange={(e) => { setInput(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            style={{
              background: 'none', border: 'none', outline: 'none',
              fontSize: 12, color: 'var(--p-text)', minWidth: 80, flex: 1,
              padding: 0, lineHeight: '1.4',
            }}
          />
        )}
      </div>

      {showDropdown && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
            background: 'var(--p-card)', border: '1px solid var(--p-border-s)',
            borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            zIndex: 50, overflow: 'hidden',
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {suggestions.map(tag => {
            const { bg, text, border } = getTagColors(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => addTag(tag)}
                style={{
                  width: '100%', textAlign: 'left', padding: '6px 10px',
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 12, color: 'var(--p-text-m)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--p-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: text, border: `1px solid ${border}`, flexShrink: 0 }} />
                {tag}
              </button>
            );
          })}
          {canCreate && (
            <button
              type="button"
              onClick={() => addTag(input.trim())}
              style={{
                width: '100%', textAlign: 'left', padding: '6px 10px',
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'none', border: suggestions.length > 0 ? '1px solid var(--p-border)' : 'none',
                borderLeft: 'none', borderRight: 'none', borderBottom: 'none',
                cursor: 'pointer', fontSize: 12, color: 'var(--p-text-g)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--p-hover)'; e.currentTarget.style.color = 'var(--p-text-m)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--p-text-g)'; }}
            >
              <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
              Create "<strong style={{ color: 'var(--p-text)' }}>{input.trim()}</strong>"
            </button>
          )}
        </div>
      )}
    </div>
  );
}
