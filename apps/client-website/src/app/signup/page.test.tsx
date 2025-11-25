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
    useSignupFlow: () =>
      actual.useSignupFlow(() => ({
        mutateAsync: mockMutateAsync,
        isPending: false,
        error: undefined,
      })),
  };
});

import { useUserStore } from '@/stores/userStore';

import SignupPage from './page';

describe('SignupPage', () => {
  it('stores the token and redirects to /home after signup success', async () => {
    // Arrange
    mockMutateAsync.mockResolvedValueOnce('reg-token');
    const user = userEvent.setup();

    render(<SignupPage />);

    // Act
    await user.type(screen.getByLabelText(/full name/i), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/email address/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    // Assert
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalled();
    });
    expect(useUserStore.getState().token).toBe('reg-token');
    expect(localStorage.getItem('client-user-store')).toContain('reg-token');

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/home');
    });
  });
});
