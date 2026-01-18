import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockReplace = vi.fn();
const mockPush = vi.fn();

type NavigationMock = {
  useRouter: () => { replace: typeof mockReplace; push: typeof mockPush };
};

vi.mock(
  'next/navigation',
  (): NavigationMock => ({
    useRouter: () => ({
      replace: mockReplace,
      push: mockPush,
    }),
  }),
);

// Mock the dashboard session check API
const mockCheckSession = vi.fn();
vi.mock('@/lib/api/dashboardAuth', () => ({
  checkDashboardSession: () => mockCheckSession(),
  dashboardLogout: vi.fn().mockResolvedValue({ success: true, message: 'Logged out' }),
}));

import { useDashboardAuthStore } from '@/stores/dashboardAuthStore';

import HomePage from './page';

describe('HomePage', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockPush.mockClear();
    mockCheckSession.mockClear();
  });

  it('redirects unauthenticated users to /login', async () => {
    // Arrange
    mockCheckSession.mockResolvedValue({ authenticated: false });
    useDashboardAuthStore.getState().setAuthenticated(false);
    useDashboardAuthStore.getState().setHasHydrated(true);

    render(<HomePage />);

    // Act & Assert
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });
    expect(screen.queryByText(/welcome home/i)).toBeNull();
  });

  it('renders protected content when session is authenticated', async () => {
    // Arrange
    mockCheckSession.mockResolvedValue({ authenticated: true });
    useDashboardAuthStore.getState().setAuthenticated(true);
    useDashboardAuthStore.getState().setHasHydrated(true);

    render(<HomePage />);

    // Act & Assert
    await waitFor(() => {
      expect(screen.getByText(/welcome home/i)).toBeInTheDocument();
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('displays logout button when authenticated', async () => {
    // Arrange
    mockCheckSession.mockResolvedValue({ authenticated: true });
    useDashboardAuthStore.getState().setAuthenticated(true);
    useDashboardAuthStore.getState().setHasHydrated(true);

    render(<HomePage />);

    // Act & Assert
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /logout/i })).toBeInTheDocument();
    });
  });
});
