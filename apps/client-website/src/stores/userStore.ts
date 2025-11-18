'use client';

import { create } from 'zustand';

type UserStoreState = {
  token: string | null;
  setToken: (token: string) => void;
  clearToken: () => void;
};

export const useUserStore = create<UserStoreState>((set) => ({
  token: null,
  setToken: (token): void => {
    set({ token });
  },
  clearToken: (): void => {
    set({ token: null });
  },
}));
