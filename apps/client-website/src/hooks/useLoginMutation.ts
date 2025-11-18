'use client';

import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { login, type LoginPayload } from '@/lib/api/login';
import { useUserStore } from '@/stores/userStore';

export const useLoginMutation = (): UseMutationResult<
  string,
  Error,
  LoginPayload
> => {
  const setToken = useUserStore((state) => state.setToken);

  return useMutation<string, Error, LoginPayload>({
    mutationFn: login,
    onSuccess: (token) => {
      setToken(token);
    },
  });
};
