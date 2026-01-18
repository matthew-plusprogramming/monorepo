'use client';

import { Button, Navbar, PageCardShell } from '@ui/components';
import { useRouter } from 'next/navigation';
import type { JSX } from 'react';

import { useProtectedDashboard } from '@/hooks/useProtectedDashboard';
import { dashboardLogout } from '@/lib/api/dashboardAuth';
import { useDashboardAuthStore } from '@/stores/dashboardAuthStore';

const HomePage = (): JSX.Element | null => {
  const { canRender, isLoading } = useProtectedDashboard();
  const router = useRouter();
  const logout = useDashboardAuthStore((state) => state.logout);

  const handleLogout = async (): Promise<void> => {
    try {
      await dashboardLogout();
      logout();
      router.push('/login');
    } catch {
      // Still clear local state and redirect on error
      logout();
      router.push('/login');
    }
  };

  if (isLoading || !canRender) {
    return null;
  }

  return (
    <PageCardShell
      cardAriaLabel="Authenticated home"
      cardAriaLabelledBy="home-title"
      eyebrow="Home"
      headingId="home-title"
      header={<Navbar />}
      mainAriaLabel="Home page"
      subtitle="You are signed in. This private space will soon grow into your project control room, keeping auth state intact between refreshes."
      title="Welcome home"
    >
      <Button
        displayStyle="secondary"
        clickStyle="3d"
        type="button"
        onClick={handleLogout}
      >
        Logout
      </Button>
    </PageCardShell>
  );
};

export default HomePage;
