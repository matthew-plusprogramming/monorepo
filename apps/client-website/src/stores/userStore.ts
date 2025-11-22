'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

type UserStoreState = {
  token: string | null;
  hasHydrated: boolean;
  setToken: (token: string) => void;
  clearToken: () => void;
  setHasHydrated: (hasHydrated: boolean) => void;
};

export const useUserStore = create<UserStoreState>()(
  persist(
    (set) => ({
      token: null,
      hasHydrated: false,
      setToken: (token): void => {
        set({ token });
      },
      clearToken: (): void => {
        set({ token: null });
      },
      setHasHydrated: (hasHydrated): void => {
        set({ hasHydrated });
      },
    }),
    {
      name: 'client-user-store',
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage:
        () =>
        (state): void => {
          state?.setHasHydrated(true);
        },
    },
  ),
);
