'use client';

import { useEffect, useMemo } from 'react';

import { useRouter } from 'next/navigation';

import { useUserStore } from '@/stores/userStore';

type UseProtectedPageOptions = {
  allowRenderWithoutToken?: boolean;
};

type UseProtectedPageResult = {
  canRender: boolean;
  hasHydrated: boolean;
  token: string | null;
};

const useProtectedPage = (
  options: UseProtectedPageOptions = {},
): UseProtectedPageResult => {
  const { allowRenderWithoutToken = false } = options;
  const router = useRouter();
  const token = useUserStore((state) => state.token);
  const hasHydrated = useUserStore((state) => state.hasHydrated);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    if (!token) {
      router.replace('/login');
    }
  }, [hasHydrated, token, router]);

  const canRender = useMemo(
    () => hasHydrated && (!!token || allowRenderWithoutToken),
    [allowRenderWithoutToken, hasHydrated, token],
  );

  return { canRender, hasHydrated, token };
};

export { useProtectedPage };
export type { UseProtectedPageOptions, UseProtectedPageResult };
