import type { UseMutationResult } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { LoginPayload } from '@/lib/api/login';

import type * as HooksModule from './hooks';

const mockPush = vi.fn();
const mockMutateAsync = vi.fn();

const createLoginMutationMock = (): UseMutationResult<
  string,
  Error,
  LoginPayload
> => ({
  context: undefined,
  data: undefined,
  error: null,
  failureCount: 0,
  failureReason: null,
  isPaused: false,
  status: 'idle',
  variables: undefined,
  submittedAt: 0,
  mutate: vi.fn(),
  mutateAsync: mockMutateAsync,
  reset: vi.fn(),
  isError: false,
  isIdle: true,
  isPending: false,
  isSuccess: false,
});

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

vi.mock('./hooks', async (): Promise<typeof HooksModule> => {
  const actual = await vi.importActual<typeof HooksModule>('./hooks');

  return {
    ...actual,
    useLoginFlow: () => actual.useLoginFlow(createLoginMutationMock),
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
