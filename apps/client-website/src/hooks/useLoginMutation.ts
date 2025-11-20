'use client';

import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { login, type LoginPayload } from '@/lib/api/login';

export const useLoginMutation = (): UseMutationResult<
  string,
  Error,
  LoginPayload
> => {
  return useMutation<string, Error, LoginPayload>({
    mutationFn: login,
  });
};
