'use client';

import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { register, type RegisterPayload } from '@/lib/api/register';

export const useRegisterMutation = (): UseMutationResult<
  string,
  Error,
  RegisterPayload
> => {
  return useMutation<string, Error, RegisterPayload>({
    mutationFn: register,
  });
};
