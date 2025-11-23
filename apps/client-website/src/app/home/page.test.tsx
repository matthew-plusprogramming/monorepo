import { render, screen, waitFor } from '@testing-library/react';
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

import HomePage from './page';

describe('HomePage', () => {
  it('redirects unauthenticated users to /login', async () => {
    // Arrange
    useUserStore.getState().clearToken();
    useUserStore.getState().setHasHydrated(true);

    render(<HomePage />);

    // Act & Assert
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });
    expect(screen.queryByText(/welcome home/i)).toBeNull();
  });

  it('renders protected content when a token exists', async () => {
    // Arrange
    useUserStore.getState().setToken('stored-token');
    useUserStore.getState().setHasHydrated(true);

    render(<HomePage />);

    // Act & Assert
    expect(await screen.findByText(/welcome home/i)).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
