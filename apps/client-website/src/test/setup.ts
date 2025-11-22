import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { useUserStore } from '@/stores/userStore';

vi.mock('next/image', () => ({
  __esModule: true,
  default: (): null => null,
}));

beforeEach((): void => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  useUserStore.getState().clearToken();
  useUserStore.getState().setHasHydrated(true);
});

afterEach((): void => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  useUserStore.getState().clearToken();
  useUserStore.getState().setHasHydrated(false);
});
