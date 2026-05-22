/**
 * CommentsInputArea — input section for adding a new comment.
 *
 * Renders a click-to-edit markdown preview when blurred, and an
 * auto-expanding textarea with an absolute-positioned send button when focused.
 */
import React from 'react';
import { MarkdownEditableField } from './MarkdownEditableField';

interface Props {
  commentInput: string;
  setCommentInput: (v: string) => void;
  commentSubmitting: boolean;
  onSubmit: () => void;
  baseRows?: number;
}

export function CommentsInputArea({
  commentInput, setCommentInput, commentSubmitting, onSubmit, baseRows = 4,
}: Props) {
  return (
    <div id="dp-comment-input-area">
      <MarkdownEditableField
        value={commentInput}
        onChange={setCommentInput}
        showPreview={false}
        setShowPreview={() => {}}
        previewId="dp-comment-tab-edit"
        textareaId="dp-comment-input"
        placeholder="Add a comment… (markdown)"
        previewEmptyText="Leave a comment (markdown)…"
        previewMinHeight={baseRows <= 2 ? 36 : 54}
        previewMaxHeight={140}
        baseRows={baseRows}
        maxRows={10}
        autoFocus
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        afterTextarea={(
          <button
            id="dp-comment-submit"
            disabled={commentSubmitting}
            onMouseDown={(e) => { e.preventDefault(); onSubmit(); }}
            title="Send (Ctrl+Enter)"
            style={{ position: 'absolute', bottom: 16, right: 8, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--p-blue)', border: 'none', borderRadius: 6, cursor: 'pointer', color: 'var(--p-white)', transition: 'background .15s' }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
              <path d="M2 8L14 2L10 8L14 14L2 8Z" fill="currentColor" />
            </svg>
          </button>
        )}
      />
    </div>
  );
}
