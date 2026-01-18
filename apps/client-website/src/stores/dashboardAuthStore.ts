'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

type DashboardAuthState = {
  isAuthenticated: boolean;
  hasHydrated: boolean;
  setAuthenticated: (authenticated: boolean) => void;
  setHasHydrated: (hasHydrated: boolean) => void;
  logout: () => void;
};

export const useDashboardAuthStore = create<DashboardAuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      hasHydrated: false,
      setAuthenticated: (authenticated): void => {
        set({ isAuthenticated: authenticated });
      },
      setHasHydrated: (hasHydrated): void => {
        set({ hasHydrated });
      },
      logout: (): void => {
        set({ isAuthenticated: false });
      },
    }),
    {
      name: 'dashboard-auth-store',
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage:
        () =>
        (state): void => {
          state?.setHasHydrated(true);
        },
    },
  ),
);
