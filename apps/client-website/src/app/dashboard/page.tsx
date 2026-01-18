'use client';

import { Navbar } from '@ui/components';
import type { JSX } from 'react';

import { Dashboard } from '@/components/Dashboard';
import { useProtectedDashboard } from '@/hooks/useProtectedDashboard';

/**
 * Dashboard Page (AS-001)
 *
 * Main dashboard view that displays all projects as cards.
 * Protected route - requires authentication.
 *
 * Features:
 * - AC1.1: Dashboard displays all projects as cards with name and status
 * - AC1.2: Each project card shows spec group count
 * - AC1.3: Each project card shows health indicator
 * - AC1.4: Projects load within 3 seconds on initial page load
 * - AC1.5: Status indicators update in real-time without page refresh
 */
const DashboardPage = (): JSX.Element | null => {
  const { canRender, isLoading } = useProtectedDashboard();

  if (isLoading || !canRender) {
    return null;
  }

  return (
    <div>
      <Navbar />
      <Dashboard enablePolling pollingInterval={5000} />
    </div>
  );
};

export default DashboardPage;
