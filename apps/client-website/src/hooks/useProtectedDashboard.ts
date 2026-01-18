'use client';

import { useEffect, useMemo, useState } from 'react';

import { useRouter } from 'next/navigation';

import { checkDashboardSession } from '@/lib/api/dashboardAuth';
import { useDashboardAuthStore } from '@/stores/dashboardAuthStore';

type UseProtectedDashboardOptions = {
  allowRenderWithoutAuth?: boolean;
};

type UseProtectedDashboardResult = {
  canRender: boolean;
  hasHydrated: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
};

/**
 * Hook for protecting dashboard pages with session-based authentication (AS-009).
 * Redirects to /login if the user is not authenticated.
 */
const useProtectedDashboard = (
  options: UseProtectedDashboardOptions = {},
): UseProtectedDashboardResult => {
  const { allowRenderWithoutAuth = false } = options;
  const router = useRouter();
  const isAuthenticated = useDashboardAuthStore((state) => state.isAuthenticated);
  const hasHydrated = useDashboardAuthStore((state) => state.hasHydrated);
  const setAuthenticated = useDashboardAuthStore((state) => state.setAuthenticated);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionChecked, setSessionChecked] = useState(false);

  // Check session on mount
  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    const verifySession = async (): Promise<void> => {
      try {
        const { authenticated } = await checkDashboardSession();
        setAuthenticated(authenticated);
        setSessionChecked(true);
        setIsLoading(false);

        if (!authenticated && !allowRenderWithoutAuth) {
          router.replace('/login');
        }
      } catch {
        setAuthenticated(false);
        setSessionChecked(true);
        setIsLoading(false);

        if (!allowRenderWithoutAuth) {
          router.replace('/login');
        }
      }
    };

    verifySession();
  }, [hasHydrated, setAuthenticated, router, allowRenderWithoutAuth]);

  // Redirect if not authenticated after session check
  useEffect(() => {
    if (!hasHydrated || !sessionChecked) {
      return;
    }

    if (!isAuthenticated && !allowRenderWithoutAuth) {
      router.replace('/login');
    }
  }, [hasHydrated, sessionChecked, isAuthenticated, router, allowRenderWithoutAuth]);

  const canRender = useMemo(
    () => hasHydrated && sessionChecked && (isAuthenticated || allowRenderWithoutAuth),
    [allowRenderWithoutAuth, hasHydrated, sessionChecked, isAuthenticated],
  );

  return { canRender, hasHydrated, isAuthenticated, isLoading };
};

export { useProtectedDashboard };
export type { UseProtectedDashboardOptions, UseProtectedDashboardResult };
