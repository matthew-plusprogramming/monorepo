import type { UseMutationResult } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  DashboardLoginPayload,
  DashboardLoginResponse,
} from '@/lib/api/dashboardAuth';

import type * as HooksModule from './hooks';

const mockPush = vi.fn();
const mockMutateAsync = vi.fn();

const createLoginMutationMock = (): UseMutationResult<
  DashboardLoginResponse,
  Error,
  DashboardLoginPayload
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

import { useDashboardAuthStore } from '@/stores/dashboardAuthStore';

import LoginPage from './page';

describe('LoginPage', () => {
  it('sets authenticated state and redirects to /home after login success', async () => {
    // Arrange
    mockMutateAsync.mockResolvedValueOnce({ success: true, message: 'Login successful' });
    const user = userEvent.setup();

    render(<LoginPage />);

    // Act
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // Assert
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalled();
    });
    expect(useDashboardAuthStore.getState().isAuthenticated).toBe(true);
    expect(localStorage.getItem('dashboard-auth-store')).toContain('"isAuthenticated":true');

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/home');
    });
  });
});
