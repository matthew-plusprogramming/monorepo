import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const mockReplace = vi.fn();

type NavigationMock = {
  useRouter: () => { replace: typeof mockReplace };
};

vi.mock(
  'next/navigation',
  (): NavigationMock => ({
    useRouter: () => ({
      replace: mockReplace,
    }),
  }),
);

import { useUserStore } from '@/stores/userStore';

import AccountPage from './page';

describe('AccountPage', () => {
  it('redirects unauthenticated visitors to /login', async () => {
    // Arrange
    useUserStore.getState().clearToken();
    useUserStore.getState().setHasHydrated(true);

    render(<AccountPage />);

    // Act & Assert
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });
    expect(screen.queryByRole('heading', { name: /your account/i })).toBeNull();
  });

  it('renders the account shell when a token exists', async () => {
    // Arrange
    useUserStore.getState().setToken('session-token');
    useUserStore.getState().setHasHydrated(true);

    render(<AccountPage />);

    // Act & Assert
    expect(
      await screen.findByRole('heading', { name: /your account/i }),
    ).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('clears the token and navigates to login on logout', async () => {
    // Arrange
    useUserStore.getState().setToken('session-token');
    useUserStore.getState().setHasHydrated(true);
    const user = userEvent.setup();

    render(<AccountPage />);

    // Act
    const logoutButton = await screen.findByRole('button', {
      name: /log out/i,
    });
    await user.click(logoutButton);
    const loggingOutButton = await screen.findByRole('button', {
      name: /logging out/i,
    });

    // Assert
    expect(useUserStore.getState().token).toBeNull();
    expect(loggingOutButton).toBeDisabled();
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });
  });
});
