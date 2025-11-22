import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const mockPush = vi.fn();
const mockMutateAsync = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('@/hooks/useLoginMutation', () => ({
  useLoginMutation: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    error: undefined,
  }),
}));

import { useUserStore } from '@/stores/userStore';

import LoginPage from './page';

describe('LoginPage', () => {
  it('stores the token and redirects to /home after login success', async () => {
    // Arrange
    mockMutateAsync.mockResolvedValueOnce('token-123');
    const user = userEvent.setup();

    render(<LoginPage />);

    // Act
    await user.type(
      screen.getByLabelText(/email address/i),
      'user@example.com',
    );
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // Assert
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalled();
    });
    expect(useUserStore.getState().token).toBe('token-123');
    expect(localStorage.getItem('client-user-store')).toContain('token-123');

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/home');
    });
  });
});
