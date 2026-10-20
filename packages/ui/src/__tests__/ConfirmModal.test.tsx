// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ConfirmModal } from '../kanban/components/ConfirmModal';

afterEach(cleanup);

describe('ConfirmModal loading feedback', () => {
  it('renders an animated spinner only while loading and disables both buttons', () => {
    const props = { open: true, message: 'Confirm this action?', confirmLabel: 'Confirm action', onConfirm: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(<ConfirmModal {...props} />);
    const confirm = screen.getByRole('button', { name: 'Confirm action' });
    expect(confirm.querySelector('svg')).toBeNull();
    expect(confirm).toBeEnabled();

    rerender(<ConfirmModal {...props} loading />);
    const loading = screen.getByRole('button', { name: 'Deleting…' });
    expect(loading.querySelector('svg')).toHaveStyle({ animation: 'spin 0.7s linear infinite' });
    expect(loading).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    rerender(<ConfirmModal {...props} loading={false} />);
    expect(screen.getByRole('button', { name: 'Confirm action' }).querySelector('svg')).toBeNull();
  });
});
