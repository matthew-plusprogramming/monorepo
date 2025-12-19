import type { UseMutationResult } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { RegisterPayload } from '@/lib/api/register';

import type * as HooksModule from './hooks';

const mockPush = vi.fn();
const mockMutateAsync = vi.fn();

const createRegisterMutationMock = (): UseMutationResult<
  string,
  Error,
  RegisterPayload
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
    useSignupFlow: () => actual.useSignupFlow(createRegisterMutationMock),
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
