import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type * as HooksModule from './hooks';

const mockPush = vi.fn();
const mockMutateAsync = vi.fn();

type NavigationMock = {
  useRouter: () => { push: typeof mockPush };
};

vi.mock(
  'next/navigation',
  (): NavigationMock => ({
    useRouter: () => ({
      push: mockPush,
    }),
  }),
);

vi.mock('./hooks', async (): Promise<HooksModule> => {
  const actual = (await vi.importActual('./hooks')) as HooksModule;

  return {
    ...actual,
    useLoginFlow: () =>
      actual.useLoginFlow(() => ({
        mutateAsync: mockMutateAsync,
        isPending: false,
        error: undefined,
      })),
  };
});

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
